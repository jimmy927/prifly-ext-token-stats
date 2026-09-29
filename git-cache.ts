/**
 * Each repository's lines added, kept in `cache/git.json` and brought up to
 * date incrementally: where the branch it was last read at is still in the
 * default branch's history, only the commits since are read. A force-push, a
 * changed default branch, a moved checkout or a new `FILTER_VERSION` read
 * the repository's history again from the start.
 */

import { existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { FILTER_VERSION } from "./code-filter";
import { type Commit, commitsIn, defaultBranch, GitFailed, isAncestor, tipOf } from "./git";
import type { ExtensionApi } from "./prifly-api";

const CACHE_VERSION = 1;

export type RepoLines = {
  path: string;
  branch: string;
  /** The commit the default branch was at when `commits` was read. */
  head: string;
  commits: Commit[];
};

type Stored = { version: number; filter: number; repos: Record<string, RepoLines> };

function isRepoLines(value: unknown): value is RepoLines {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v["path"] === "string" &&
    typeof v["branch"] === "string" &&
    typeof v["head"] === "string" &&
    Array.isArray(v["commits"]) &&
    v["commits"].every(
      (c) => Array.isArray(c) && c.length === 2 && c.every((n) => typeof n === "number"),
    )
  );
}

/** The cache as read; one written under other versions, or unreadable, is as good as none. */
function decode(raw: unknown): Map<string, RepoLines> {
  if (typeof raw !== "object" || raw === null) return new Map();
  const stored = raw as Record<string, unknown>;
  if (stored["version"] !== CACHE_VERSION || stored["filter"] !== FILTER_VERSION) return new Map();
  const repos = stored["repos"];
  if (typeof repos !== "object" || repos === null) return new Map();
  return new Map(
    Object.entries(repos).filter((entry): entry is [string, RepoLines] => isRepoLines(entry[1])),
  );
}

/** What `code-answer.ts` asks of the history. */
export type LinesSource = {
  /** A repository's commits with code lines, oldest first; null where it has no checkout read. */
  lines(name: string): readonly Commit[] | null;
  /** The repositories with a history read. */
  names(): string[];
  /** Whether a history is there to answer from: read from the file, or this run. */
  ready(): boolean;
};

export class GitLines implements LinesSource {
  private repos = new Map<string, RepoLines>();
  private readThisRun = false;

  private readonly file: string;

  constructor(file: string) {
    this.file = file;
  }

  private loading: Promise<void> | null = null;

  /** Read the file, once. */
  load(): Promise<void> {
    this.loading ??= this.read();
    return this.loading;
  }

  private async read(): Promise<void> {
    if (!existsSync(this.file)) return;
    this.repos = decode(
      await Bun.file(this.file)
        .json()
        .catch(() => null),
    );
  }

  lines(name: string): readonly Commit[] | null {
    return this.repos.get(name)?.commits ?? null;
  }

  names(): string[] {
    return [...this.repos.keys()];
  }

  ready(): boolean {
    return this.readThisRun || this.repos.size > 0;
  }

  /**
   * Bring each repository's lines up to date, one after the other: git is
   * light on a repository, but a first read of a long history is not to run
   * beside others. A repository git cannot read this time keeps what it had.
   */
  async refresh(checkouts: ReadonlyMap<string, string>, log: ExtensionApi["log"]): Promise<void> {
    await this.load();
    let changed = false;
    for (const [name, path] of checkouts) {
      try {
        changed = (await this.refreshOne(name, path)) || changed;
      } catch (error) {
        if (!(error instanceof GitFailed)) throw error;
        log("git_failed", { repo: name, error: error.message });
      }
    }
    this.readThisRun = true;
    if (changed) await this.save();
  }

  /** True when the repository's lines changed. */
  private async refreshOne(name: string, path: string): Promise<boolean> {
    const branch = await defaultBranch(path);
    const head = branch === null ? null : await tipOf(path, branch);
    if (branch === null || head === null) return this.repos.delete(name);
    const known = this.repos.get(name);
    if (known?.path === path && known.branch === branch && known.head === head) return false;
    const continues =
      known?.path === path && known.branch === branch && (await isAncestor(path, known.head, head));
    const commits = continues
      ? [...known.commits, ...(await commitsIn(path, `${known.head}..${branch}`))]
      : await commitsIn(path, branch);
    commits.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    this.repos.set(name, { path, branch, head, commits });
    return true;
  }

  /** Written whole to a temporary file first, so a crash mid-write leaves the old one. */
  private async save(): Promise<void> {
    mkdirSync(dirname(this.file), { recursive: true });
    const stored: Stored = {
      version: CACHE_VERSION,
      filter: FILTER_VERSION,
      repos: Object.fromEntries(this.repos),
    };
    const temporary = `${this.file}.writing`;
    await Bun.write(temporary, JSON.stringify(stored));
    renameSync(temporary, this.file);
  }
}
