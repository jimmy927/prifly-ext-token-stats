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

import { statSync } from "node:fs";
import { dirname } from "node:path";
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
  };
};

// 2: calls keep their 1-hour cache writes apart, for the cost; older caches are read again.
// 3: transcripts keep the repositories they wrote into; older caches are read again.
const CACHE_VERSION = 3;
const files = new Map<string, FileState>();
const archive = new Map<string, FileOut>();
let cache: LocalCache | null = null;
let transcripts: Transcripts | null = null;
let first = true;

async function loadCache(request: ScanRequest): Promise<LocalCache> {
  for (const file of await loadArchive(request.archiveFile)) archive.set(file.path, file);
  const opened = new LocalCache(request.cacheFile, CACHE_VERSION);
  for (const state of opened.load(request.legacyCacheFile)) files.set(state.path, state);
  return opened;
}

function idsOf(path: string): { sessionId: string; parentId: string | null } {
  const at = path.indexOf("/subagents/");
  if (at < 0) return { sessionId: path.slice(path.lastIndexOf("/") + 1, -6), parentId: null };
  const parentId = path.slice(path.lastIndexOf("/", at - 1) + 1, at);
  return { sessionId: `${parentId}/${path.slice(path.lastIndexOf("/") + 1, -6)}`, parentId };
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
  transcripts ??= new Transcripts(request.root);
  // A turn of the event loop first: the watcher's events queued before this request are then in.
  await new Promise((resolve) => setTimeout(resolve, 0));
  const selection = transcripts.select();
  const candidates = [...selection.main, ...selection.agents];
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
  const removed = selection.full
    ? [...files.keys()].filter((path) => !present.has(path))
    : [...files.keys()].filter((path) => selection.gone.some((gone) => within(path, gone)));
  // Only a path that was read reclaims its archived copy: one that failed to read keeps it.
  const live = new Set([...present].filter((path) => files.has(path)));
  const { archived, reclaimed } = await keep(removed, live, request.archiveFile);
  for (const path of removed) files.delete(path);
  cache.save(files);
  const ms = Math.round(performance.now() - started);
  const { full, dirs, statted, flagged } = selection;
  const grown = first ? [] : changed.map((file) => file.path);
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
      full,
      dirs,
      // `readFile` stats each candidate once.
      statted: statted + candidates.length,
      missed: flagged === null ? 0 : missedBy(request.root, flagged, grown),
    },
  };
  first = false;
  return reply;
}

function within(path: string, gone: string): boolean {
  return path === gone || path.startsWith(`${gone}/`);
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
  };
}

self.onmessage = async (event: MessageEvent<ScanRequest>) => {
  self.postMessage(await scan(event.data));
};
