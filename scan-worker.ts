/**
 * The local scan, off the host's thread: Claude Code's transcripts under
 * `~/.claude/projects` run to gigabytes, and the host must not stall while
 * they are read.
 *
 * Incremental twice over. A file whose size and mtime are unchanged is not
 * opened; a file that grew is read from where the last scan stopped, with the
 * reader's state (the account in force, the folder, the title) carried over.
 * What was read is kept in a cache file, so a host restart costs a stat per
 * file rather than the whole read again.
 */

/// <reference lib="webworker" />

import { lstatSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { type FileOut, loadArchive, saveArchive, settleArchive } from "./archive";
import { accountAt, freshState, type ReaderState, readText } from "./parse";

declare const self: Worker;

export type { FileOut } from "./archive";

type FileState = FileOut & { size: number; mtime: number; offset: number; reader: ReaderState };

export type ScanRequest = { type: "scan"; root: string; cacheFile: string; archiveFile: string };
export type ScanReply = {
  type: "scanned";
  /** Files that changed since the last reply — all of them in the first. */
  files: FileOut[];
  removed: string[];
  /** Files Claude Code deleted, kept: those newly archived, and the whole archive in the first. */
  archived: FileOut[];
  /** Archived paths that are on disk again, and counted from there now. */
  reclaimed: string[];
  stats: { files: number; read: number; bytes: number; ms: number };
};

// 2: calls keep their 1-hour cache writes apart, for the cost; older caches are read again.
const CACHE_VERSION = 2;
const files = new Map<string, FileState>();
const archive = new Map<string, FileOut>();
let loaded = false;
let first = true;

async function loadCache(cacheFile: string, archiveFile: string): Promise<void> {
  loaded = true;
  for (const file of await loadArchive(archiveFile)) archive.set(file.path, file);
  const raw: unknown = await Bun.file(cacheFile)
    .json()
    .catch(() => null);
  if (typeof raw !== "object" || raw === null) return;
  const cache = raw as { version?: unknown; files?: unknown };
  if (cache.version !== CACHE_VERSION || !Array.isArray(cache.files)) return;
  for (const entry of cache.files as FileState[]) files.set(entry.path, entry);
}

/** Every transcript, sessions' own first: a sub-agent's account is read off its parent's. */
function listTranscripts(root: string): { main: string[]; agents: string[] } {
  const main: string[] = [];
  const agents: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        (path.includes("/subagents/") ? agents : main).push(path);
      }
    }
  };
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    // `~/odi` beside `~/src/odi`: a symlinked project folder repeats another.
    if (entry.isDirectory() && !lstatSync(join(root, entry.name)).isSymbolicLink()) {
      walk(join(root, entry.name));
    }
  }
  return { main, agents };
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
  state.offset += end;
  state.size = stat.size;
  state.mtime = stat.mtimeMs;
  state.title = (parent ?? state).reader.title || (parent ?? state).reader.prompt;
  return end;
}

const bySession = new Map<string, FileState>();
function findSession(id: string): FileState | null {
  return bySession.get(id) ?? null;
}

async function scan(request: ScanRequest): Promise<ScanReply> {
  const started = performance.now();
  if (!loaded) await loadCache(request.cacheFile, request.archiveFile);
  const { main, agents } = listTranscripts(request.root);
  const changed: FileOut[] = [];
  let bytes = 0;
  for (const path of [...main, ...agents]) {
    const read = await readFile(path).catch(() => 0);
    const state = files.get(path);
    if (state !== undefined && state.parentId === null) bySession.set(state.sessionId, state);
    if (state !== undefined && (read > 0 || first)) changed.push(strip(state));
    bytes += read;
  }
  const present = new Set([...main, ...agents]);
  const removed = [...files.keys()].filter((path) => !present.has(path));
  // Only a path that was read reclaims its archived copy: one that failed to read keeps it.
  const live = new Set([...present].filter((path) => files.has(path)));
  const { archived, reclaimed } = await keep(removed, live, request.archiveFile);
  for (const path of removed) files.delete(path);
  if (bytes > 0 || removed.length > 0) await saveCache(request.cacheFile);
  const ms = Math.round(performance.now() - started);
  const reply: ScanReply = {
    type: "scanned",
    files: changed,
    removed,
    archived: first ? [...archive.values()] : archived,
    reclaimed,
    stats: { files: present.size, read: changed.length, bytes, ms },
  };
  first = false;
  return reply;
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
  };
}

async function saveCache(cacheFile: string): Promise<void> {
  mkdirSync(dirname(cacheFile), { recursive: true });
  await Bun.write(
    cacheFile,
    JSON.stringify({ version: CACHE_VERSION, files: [...files.values()] }),
  );
}

self.onmessage = async (event: MessageEvent<ScanRequest>) => {
  self.postMessage(await scan(event.data));
};
