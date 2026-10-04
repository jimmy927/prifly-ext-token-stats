/**
 * Remote sessions: Claude Code on the web, run in Anthropic's sandboxes. Their
 * transcripts are not on this machine; prifly reads them through the session
 * API with the token of the account that created each one (`api.cloud`).
 *
 * A transcript is fetched again only when its session moved since, and what
 * was read is kept in a cache file between host restarts.
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { freshState, type HumanEvent, readLine, type Usage } from "./parse";
import type { CloudSessionInfo, ExtensionCloud } from "./prifly-api";
import type { Batch } from "./store";
import { repoOfUrl } from "./where";

/**
 * `human` is absent on a session read before the reader's events were kept,
 * `prompts` on one read before their prompts' tokens were.
 */
type Held = { info: CloudSessionInfo; usages: Usage[]; human?: HumanEvent[]; prompts?: true };

const CACHE_VERSION = 1;

export class RemoteSessions {
  /**
   * Every session ever read, kept for good: one that drops out of the API's
   * listing (deleted, or aged out) keeps counting. Nothing removes from it.
   */
  private readonly held = new Map<string, Held>();
  private loaded = false;
  /** Why the last read failed, or "". */
  error = "";
  readAt = 0;

  private readonly cloud: ExtensionCloud;
  private readonly cacheFile: string;
  private readonly log: (event: string, fields: Record<string, string | number>) => void;

  constructor(
    cloud: ExtensionCloud,
    cacheFile: string,
    log: (event: string, fields: Record<string, string | number>) => void,
  ) {
    this.cloud = cloud;
    this.cacheFile = cacheFile;
    this.log = log;
  }

  batches(): Batch[] {
    return [...this.held.values()].map(({ info, usages, human }) => ({
      sessionId: info.id,
      title: info.title,
      source: "remote",
      repo: info.repo === "" ? "unknown" : repoOfUrl(info.repo),
      usages,
      ...(human === undefined ? {} : { human }),
    }));
  }

  get count(): number {
    return this.held.size;
  }

  /** Read what moved since the last time; true when anything changed. */
  async refresh(): Promise<boolean> {
    if (!this.loaded) await this.load();
    let changed = false;
    try {
      // Only what is listed is fetched again; what is not listed is left as held, never pruned.
      const sessions = await this.cloud.sessions();
      for (const info of sessions) {
        const held = this.held.get(info.id);
        // One read before the reader's events and prompts were kept is fetched again, once, while still listed.
        const current = held?.info.updatedAt === info.updatedAt && held.prompts === true;
        if (current) continue;
        changed = (await this.fetch(info)) || changed;
      }
      this.error = "";
    } catch (caught) {
      this.error = caught instanceof Error ? caught.message : String(caught);
      this.log("remote_failed", { error: this.error.slice(0, 200) });
    }
    this.readAt = Date.now();
    if (changed) await this.save();
    return changed;
  }

  /** One session's transcript; a session that cannot be read leaves the others standing. */
  private async fetch(info: CloudSessionInfo): Promise<boolean> {
    try {
      const lines = await this.cloud.transcript(info.account, info.id);
      this.held.set(info.id, { info, ...this.read(info, lines) });
      return true;
    } catch (caught) {
      const error = caught instanceof Error ? caught.message : String(caught);
      this.log("remote_session_failed", { session: info.id, error: error.slice(0, 200) });
      return false;
    }
  }

  /** A transcript's calls, and the reader's events: the same reader as a local session's. */
  private read(
    info: CloudSessionInfo,
    lines: unknown[],
  ): { usages: Usage[]; human: HumanEvent[]; prompts: true } {
    const state = freshState(info.account);
    const usages: Usage[] = [];
    for (const line of lines) {
      if (typeof line !== "object" || line === null) continue;
      const usage = readLine(state, line as Record<string, unknown>, () => info.account);
      if (usage !== null) usages.push(usage);
    }
    return { usages, human: state.human, prompts: true };
  }

  private async load(): Promise<void> {
    this.loaded = true;
    const raw: unknown = await Bun.file(this.cacheFile)
      .json()
      .catch(() => null);
    const cache = raw as { version?: unknown; sessions?: unknown } | null;
    if (cache?.version !== CACHE_VERSION || !Array.isArray(cache.sessions)) return;
    for (const held of cache.sessions as Held[]) this.held.set(held.info.id, held);
  }

  private async save(): Promise<void> {
    mkdirSync(dirname(this.cacheFile), { recursive: true });
    await Bun.write(
      this.cacheFile,
      JSON.stringify({ version: CACHE_VERSION, sessions: [...this.held.values()] }),
    );
  }
}
