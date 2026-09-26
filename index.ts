/**
 * Token statistics: a window of prifly's own, opened from the status bar, of
 * how many tokens Claude Code used — over time, and split by account, model,
 * repository, folder, local/remote or session.
 *
 * Local sessions are read from `~/.claude/projects` by a worker thread
 * (`scan-worker.ts`); remote ones through prifly's cloud access
 * (`remote.ts`). The window's page (`panel/`) asks `api/stats` for each view
 * and `api/status` for how far the reading has got.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { Answerer, readParams } from "./answer";
import type { ExtensionApi, PanelRequest } from "./prifly-api";
import { RemoteSessions } from "./remote";
import type { FileOut, ScanReply, ScanRequest } from "./scan-worker";
import { type Batch, buildColumns } from "./store";

const LOCAL_EVERY = 60_000;
const REMOTE_EVERY = 10 * 60_000;

type Running = {
  worker: Worker;
  local: Map<string, FileOut>;
  remote: RemoteSessions;
  answerer: Answerer | null;
  scanning: Promise<void> | null;
  resolveScan: (() => void) | null;
  lastScan: ScanReply["stats"] | null;
  scannedAt: number;
  request: ScanRequest;
};

let running: Running | null = null;

function localBatches(local: Map<string, FileOut>): Batch[] {
  return [...local.values()].map((file) => ({
    sessionId: file.sessionId,
    title: file.title,
    source: "local",
    repo: null,
    usages: file.usages,
  }));
}

function answerer(state: Running): Answerer {
  if (state.answerer === null) {
    state.answerer = new Answerer(
      buildColumns([...localBatches(state.local), ...state.remote.batches()]),
    );
  }
  return state.answerer;
}

function scanLocal(state: Running): Promise<void> {
  if (state.scanning !== null) return state.scanning;
  state.scanning = new Promise<void>((resolve) => {
    state.resolveScan = resolve;
    state.worker.postMessage(state.request);
  });
  return state.scanning;
}

function received(state: Running, reply: ScanReply, log: ExtensionApi["log"]): void {
  for (const file of reply.files) state.local.set(file.path, file);
  for (const path of reply.removed) state.local.delete(path);
  if (reply.files.length > 0 || reply.removed.length > 0) state.answerer = null;
  state.lastScan = reply.stats;
  state.scannedAt = Date.now();
  log("scanned", reply.stats);
  state.scanning = null;
  state.resolveScan?.();
  state.resolveScan = null;
}

async function scanRemote(state: Running): Promise<void> {
  if (await state.remote.refresh()) state.answerer = null;
}

export function activate(api: ExtensionApi): () => void {
  const worker = new Worker(new URL("./scan-worker.ts", import.meta.url).href);
  const state: Running = {
    worker,
    local: new Map(),
    remote: new RemoteSessions(api.cloud, join(api.folder, "cache", "remote.json"), api.log),
    answerer: null,
    scanning: null,
    resolveScan: null,
    lastScan: null,
    scannedAt: 0,
    request: {
      type: "scan",
      root: join(homedir(), ".claude", "projects"),
      cacheFile: join(api.folder, "cache", "local.json"),
    },
  };
  worker.onmessage = (event: MessageEvent<ScanReply>) => received(state, event.data, api.log);
  worker.onerror = (event) => {
    api.log("scan_failed", { error: event.message });
    state.scanning = null;
    state.resolveScan?.();
  };
  running = state;
  void scanLocal(state);
  const remoteSoon = setTimeout(() => void scanRemote(state), 5_000);
  const localTimer = setInterval(() => void scanLocal(state), LOCAL_EVERY);
  const remoteTimer = setInterval(() => void scanRemote(state), REMOTE_EVERY);
  return () => {
    clearTimeout(remoteSoon);
    clearInterval(localTimer);
    clearInterval(remoteTimer);
    worker.terminate();
    running = null;
  };
}

function status(state: Running) {
  return {
    ready: state.lastScan !== null,
    scanning: state.scanning !== null,
    scannedAt: state.scannedAt,
    local: state.lastScan,
    sessions: state.local.size,
    remote: {
      sessions: state.remote.count,
      readAt: state.remote.readAt,
      error: state.remote.error,
    },
  };
}

export async function panel(_panelId: string, request: PanelRequest): Promise<unknown> {
  const state = running;
  if (state === null) throw new Error("Token statistics is not running.");
  switch (request.path) {
    case "status":
      return status(state);
    case "refresh":
      await Promise.all([scanLocal(state), scanRemote(state)]);
      return status(state);
    case "stats":
      if (state.lastScan === null) await scanLocal(state);
      return answerer(state).answer(readParams(request.query, Date.now()));
    default:
      throw new Error(`No such request: ${request.path}`);
  }
}
