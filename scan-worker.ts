/**
 * The local scan, off the host's thread: Claude Code's transcripts under
 * `~/.claude/projects` run to gigabytes, and the host must not stall while
 * they are read.
 *
 * Incremental three times over. Only files a watcher saw change are stat'ed,
 * with a full listing every ten minutes (`transcripts.ts`). A file whose size
 * and mtime are unchanged is not opened; a file that grew is read from where the last scan stopped, with the
 * reader's state (the account in force, the folder, the title) carried over.
 * What was read is kept in a cache (`local-cache.ts`), so a host restart
 * costs a stat per file rather than the whole read again.
 */

/// <reference lib="webworker" />

import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { type FileOut, loadArchive, saveArchive, settleArchive } from "./archive";
import { type FileState, LocalCache } from "./local-cache";
import { accountAt, freshState, readText } from "./parse";
import { missedBy, Transcripts } from "./transcripts";
import { repoOfPath } from "./where";

declare const self: Worker;

export type { FileOut } from "./archive";

export type ScanRequest = {
  type: "scan";
  root: string;
  /** The SQLite cache. */
  cacheFile: string;
  /** The JSON cache it replaced: read once, into an empty `cacheFile`. */
  legacyCacheFile: string;
  archiveFile: string;
  /**
   * prifly's `machine-history`: with its node agent on, a copy of each other
   * machine's `projects` on this laptop, under `<machine>/projects` — the WSL
   * distribution's for a host on Windows (prifly's `history/machine-mirror.ts`).
   * Read as further roots, from this OS's own disk.
   */
  mirrors?: string;
};
export type ScanReply = {
  type: "scanned";
  /** Files that changed since the last reply — all of them in the first. */
  files: FileOut[];
  removed: string[];
  /** Files Claude Code deleted, kept: those newly archived, and the whole archive in the first. */
  archived: FileOut[];
  /** Archived paths that are on disk again, and counted from there now. */
  reclaimed: string[];
  stats: {
    files: number;
    read: number;
    bytes: number;
    ms: number;
    /** Every transcript listed and stat'ed, or only those the watcher named (`transcripts.ts`). */
    full: boolean;
    dirs: number;
    statted: number;
    /** A full pass: files that had changed although the watcher had not named them. */
    missed: number;
    /** Transcripts in prifly's copies of the other machines' history (`mirrors`). */
    mirrored: number;
  };
};

// 2: calls keep their 1-hour cache writes apart, for the cost; older caches are read again.
// 3: transcripts keep the repositories they wrote into; older caches are read again.
// 4: transcripts keep their weekly-limit refusals; older caches are read again.
// 5: session transcripts keep the reader's own events, for the active time; older caches are read again.
// 6: a prompt the reader wrote keeps its estimated tokens; older caches are read again.
const CACHE_VERSION = 6;
const files = new Map<string, FileState>();
const archive = new Map<string, FileOut>();
let cache: LocalCache | null = null;
/** One per root: `~/.claude/projects` first, then each machine's copy, by its folder. */
const roots = new Map<string, Transcripts>();
let first = true;

async function loadCache(request: ScanRequest): Promise<LocalCache> {
  for (const file of await loadArchive(request.archiveFile)) archive.set(file.path, file);
  const opened = new LocalCache(request.cacheFile, CACHE_VERSION);
  // Ids again from the path: a host on Windows cached them before `idsOf` knew its `\`.
  for (const state of opened.load(request.legacyCacheFile)) {
    files.set(state.path, { ...state, ...idsOf(state.path) });
  }
  return opened;
}

/** A session's id is its file's name; a sub-agent's is its session's and its own. */
function idsOf(path: string): { sessionId: string; parentId: string | null } {
  const parts = path.split(/[\\/]/);
  const name = (parts.at(-1) ?? "").slice(0, -6);
  if (parts.at(-2) !== "subagents") return { sessionId: name, parentId: null };
  const parentId = parts.at(-3) ?? "";
  return { sessionId: `${parentId}/${name}`, parentId };
}

/**
 * The folders whose transcripts are read: Claude Code's own, and prifly's
 * copy of each other machine's on this laptop (`mirrors`) — for a host on
 * Windows, the WSL distribution's, where the sessions run.
 */
function rootsOf(request: ScanRequest): string[] {
  const copies = request.mirrors === undefined ? [] : mirrorRoots(request.mirrors);
  return [request.root, ...copies];
}

function mirrorRoots(base: string): string[] {
  try {
    return readdirSync(base, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(base, entry.name, "projects"))
      .filter((projects) => existsSync(projects));
  } catch {
    // No copies: the node agent is off, or there is no other machine.
    return [];
  }
}

/** A watcher for each root new since the last scan; a copy prifly removed is no root any more. */
function updateRoots(now: string[]): void {
  for (const root of now) if (!roots.has(root)) roots.set(root, new Transcripts(root));
  for (const [root, transcripts] of roots) {
    if (now.includes(root)) continue;
    transcripts.close();
    roots.delete(root);
  }
}

/** Read what was added to one file; the bytes read, or 0 when it was unchanged. */
async function readFile(path: string): Promise<number> {
  const stat = statSync(path);
  let state = files.get(path);
  if (state !== undefined && state.size === stat.size && state.mtime === stat.mtimeMs) return 0;
  if (state === undefined || stat.size < state.offset) {
    state = {
      ...idsOf(path),
      path,
      title: "",
      usages: [],
      size: 0,
      mtime: 0,
      offset: 0,
      reader: freshState(),
    };
    files.set(path, state);
  }
  const bytes = new Uint8Array(await Bun.file(path).slice(state.offset, stat.size).arrayBuffer());
  // Up to the last whole line: one still being written is read next time.
  const end = bytes.lastIndexOf(10) + 1;
  const parent = state.parentId === null ? null : findSession(state.parentId);
  const fixed =
    parent === null
      ? null
      : (ts: number) => accountAt(parent.reader.segments, ts) || parent.reader.account;
  state.usages.push(
    ...readText(state.reader, new TextDecoder().decode(bytes.subarray(0, end)), fixed),
  );
  countWrites(state);
  const hits = state.reader.hits.splice(0);
  if (hits.length > 0) state.hits = [...(state.hits ?? []), ...hits];
  // A sub-agent's "user" lines are its parent's prompts and tool results, never the reader's.
  const human = state.reader.human.splice(0);
  if (human.length > 0 && state.parentId === null) {
    state.human ??= [];
    state.human.push(...human);
  }
  state.offset += end;
  state.size = stat.size;
  state.mtime = stat.mtimeMs;
  state.title = (parent ?? state).reader.title || (parent ?? state).reader.prompt;
  return end;
}

/**
 * Each folder's repository, as first found. A file is placed as it is read,
 * while it most likely still exists, and the count is kept in the cache and
 * the archive: a worktree removed since does not move what was counted.
 */
const repoOfFolder = new Map<string, string | null>();

/** The files the reader just saw written, counted into their repositories; scratch files are not. */
function countWrites(state: FileState): void {
  for (const path of state.reader.written.splice(0)) {
    const folder = dirname(path);
    let repo = repoOfFolder.get(folder);
    if (repo === undefined) {
      repo = repoOfPath(path);
      repoOfFolder.set(folder, repo);
    }
    if (repo === null) continue;
    state.writes ??= {};
    state.writes[repo] = (state.writes[repo] ?? 0) + 1;
  }
}

const bySession = new Map<string, FileState>();
function findSession(id: string): FileState | null {
  return bySession.get(id) ?? null;
}

async function scan(request: ScanRequest): Promise<ScanReply> {
  const started = performance.now();
  cache ??= await loadCache(request);
  updateRoots(rootsOf(request));
  // A turn of the event loop first: the watcher's events queued before this request are then in.
  await new Promise((resolve) => setTimeout(resolve, 0));
  const selections = [...roots].map(([root, transcripts]) => ({ root, ...transcripts.select() }));
  // Sessions before sub-agents, from every root: a sub-agent's account is read off its parent's.
  const candidates = [
    ...selections.flatMap((selection) => selection.main),
    ...selections.flatMap((selection) => selection.agents),
  ];
  const changed: FileOut[] = [];
  let bytes = 0;
  for (const path of candidates) {
    const read = await readFile(path).catch(() => 0);
    const state = files.get(path);
    if (state !== undefined && state.parentId === null) bySession.set(state.sessionId, state);
    if (state !== undefined && (read > 0 || first)) changed.push(strip(state));
    bytes += read;
  }
  const present = new Set(candidates);
  const removed = [...files.keys()].filter((path) => {
    const selection = selections.find((s) => within(path, s.root));
    // Under no root scanned now (a copy prifly removed): kept, as read.
    if (selection === undefined) return false;
    return selection.full ? !present.has(path) : selection.gone.some((gone) => within(path, gone));
  });
  // Only a path that was read reclaims its archived copy: one that failed to read keeps it.
  const live = new Set([...present].filter((path) => files.has(path)));
  const { archived, reclaimed } = await keep(removed, live, request.archiveFile);
  for (const path of removed) files.delete(path);
  cache.save(files);
  const ms = Math.round(performance.now() - started);
  const grown = first ? [] : changed.map((file) => file.path);
  const copies = selections.slice(1);
  const mirrored = [...files.keys()].filter((path) => copies.some((s) => within(path, s.root)));
  const reply: ScanReply = {
    type: "scanned",
    files: changed,
    removed,
    archived: first ? [...archive.values()] : archived,
    reclaimed,
    stats: {
      files: files.size,
      read: changed.length,
      bytes,
      ms,
      full: selections.every((s) => s.full),
      dirs: selections.reduce((n, s) => n + s.dirs, 0),
      // `readFile` stats each candidate once.
      statted: selections.reduce((n, s) => n + s.statted, 0) + candidates.length,
      missed: selections.reduce((n, s) => {
        if (s.flagged === null) return n;
        return (
          n +
          missedBy(
            s.root,
            s.flagged,
            grown.filter((path) => within(path, s.root)),
          )
        );
      }, 0),
      mirrored: mirrored.length,
    },
  };
  first = false;
  return reply;
}

/** `path` is `dir` or under it, with either separator: the host's own paths on Windows have `\\`. */
function within(path: string, dir: string): boolean {
  if (path === dir) return true;
  const next = path[dir.length];
  return path.startsWith(dir) && (next === "/" || next === "\\");
}

/** Transcripts that left the disk go into the archive, which is written only when it changed. */
async function keep(removed: string[], live: ReadonlySet<string>, archiveFile: string) {
  const gone = removed.flatMap((path) => {
    const state = files.get(path);
    return state === undefined ? [] : [strip(state)];
  });
  const settled = settleArchive(archive, gone, live);
  if (settled.archived.length > 0 || settled.reclaimed.length > 0) {
    await saveArchive(archiveFile, archive.values());
  }
  return settled;
}

function strip(state: FileState): FileOut {
  return {
    path: state.path,
    sessionId: state.sessionId,
    parentId: state.parentId,
    title: state.title,
    usages: state.usages,
    ...(state.writes === undefined ? {} : { writes: state.writes }),
    ...(state.hits === undefined ? {} : { hits: state.hits }),
    ...(state.human === undefined ? {} : { human: state.human }),
  };
}

self.onmessage = async (event: MessageEvent<ScanRequest>) => {
  self.postMessage(await scan(event.data));
};
