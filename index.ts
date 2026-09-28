/**
 * Token statistics: a window of prifly's own, opened from the status bar, of
 * how many tokens Claude Code used — over time, and split by account, model,
 * repository, folder, local/remote or session.
 *
 * Local sessions are read from `~/.claude/projects` by a worker thread
 * (`scan-worker.ts`); remote ones through prifly's cloud access
 * (`remote.ts`). The window's page (`panel/`) asks `api/stats` for each view
 * and `api/status` for how far the reading has got.
 *
 * The Forecast view asks `api/forecast`: prifly's account limits, read every
 * 5 minutes into `readings.ts` and turned into runways by `forecast.ts`.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { Answerer, readParams } from "./answer";
import { applyScan } from "./archive";
import { DAILY_DAYS, type ForecastAnswer, forecast } from "./forecast";
import { costHistory, limitHistory } from "./history";
import type { ExtensionApi, PanelRequest } from "./prifly-api";
import { Readings } from "./readings";
import { RemoteSessions } from "./remote";
import type { FileOut, ScanReply, ScanRequest } from "./scan-worker";
import { type Batch, buildColumns } from "./store";

const LOCAL_EVERY = 60_000;
const REMOTE_EVERY = 10 * 60_000;
/** prifly's pollers read an account's limits at most this often. */
const READINGS_EVERY = 5 * 60_000;

type Running = {
  worker: Worker;
  local: Map<string, FileOut>;
  /** Transcripts Claude Code has deleted, kept by the worker: counted like the live ones. */
  archived: Map<string, FileOut>;
  remote: RemoteSessions;
  answerer: Answerer | null;
  scanning: Promise<void> | null;
  resolveScan: (() => void) | null;
  lastScan: ScanReply["stats"] | null;
  scannedAt: number;
  request: ScanRequest;
  readings: Readings;
  /**
   * The host's `accounts()`, or null on a prifly from before it had one: the
   * Forecast view then says to update prifly.
   */
  accounts: ExtensionApi["accounts"] | null;
};

let running: Running | null = null;

function localBatches(state: Running): Batch[] {
  return [...state.local.values(), ...state.archived.values()].map((file) => ({
    sessionId: file.sessionId,
    title: file.title,
    source: "local",
    repo: null,
    usages: file.usages,
    ...(file.writes === undefined ? {} : { writes: file.writes }),
  }));
}

function answerer(state: Running): Answerer {
  if (state.answerer === null) {
    state.answerer = new Answerer(
      buildColumns([...localBatches(state), ...state.remote.batches()]),
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
  if (applyScan(state.local, state.archived, reply)) state.answerer = null;
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

function readLimits(state: Running): void {
  if (state.accounts !== null) state.readings.take(state.accounts(), Date.now());
}

function forecastAnswer(state: Running, query: Record<string, string>): ForecastAnswer {
  const now = Date.now();
  const tz = Number(query["tz"] ?? 0);
  const minutes = Number.isFinite(tz) ? tz : 0;
  const found = forecast(state.readings.all(), state.readings.accounts, now, minutes * 60_000);
  const hits = [...state.local.values(), ...state.archived.values()].flatMap((f) => f.hits ?? []);
  const resets = found.accounts.map((a) => ({
    email: a.email,
    resetsAt: a.weekly?.resetsAt ?? null,
  }));
  const { buckets, series } = answerer(state).costByDay(DAILY_DAYS, now, minutes);
  return {
    supported: state.accounts !== null,
    newestAt: state.readings.newestAt,
    ...found,
    history: limitHistory(hits, resets, now),
    cost: costHistory(
      buckets,
      series,
      found.accounts.map((a) => a.email),
    ),
  };
}

export function activate(api: ExtensionApi): () => void {
  const worker = new Worker(new URL("./scan-worker.ts", import.meta.url).href);
  const state: Running = {
    worker,
    local: new Map(),
    archived: new Map(),
    remote: new RemoteSessions(api.cloud, join(api.folder, "cache", "remote.json"), api.log),
    answerer: null,
    scanning: null,
    resolveScan: null,
    lastScan: null,
    scannedAt: 0,
    request: {
      type: "scan",
      root: join(homedir(), ".claude", "projects"),
      cacheFile: join(api.folder, "cache", "local.sqlite"),
      legacyCacheFile: join(api.folder, "cache", "local.json"),
      archiveFile: join(api.folder, "cache", "archive.json"),
    },
    readings: new Readings(join(api.folder, "cache", "readings.jsonl")),
    // A host older than the contract's `accounts()` has no such function.
    accounts: typeof api.accounts === "function" ? () => api.accounts() : null,
  };
  worker.onmessage = (event: MessageEvent<ScanReply>) => received(state, event.data, api.log);
  worker.onerror = (event) => {
    api.log("scan_failed", { error: event.message });
    state.scanning = null;
    state.resolveScan?.();
  };
  running = state;
  state.readings.load(Date.now());
  readLimits(state);
  void scanLocal(state);
  const remoteSoon = setTimeout(() => void scanRemote(state), 5_000);
  const localTimer = setInterval(() => void scanLocal(state), LOCAL_EVERY);
  const remoteTimer = setInterval(() => void scanRemote(state), REMOTE_EVERY);
  const readingsTimer = setInterval(() => readLimits(state), READINGS_EVERY);
  return () => {
    clearInterval(readingsTimer);
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
    archived: state.archived.size,
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
      readLimits(state);
      await Promise.all([scanLocal(state), scanRemote(state)]);
      return status(state);
    case "forecast":
      return forecastAnswer(state, request.query);
    case "stats": {
      if (state.lastScan === null) await scanLocal(state);
      const now = Date.now();
      return answerer(state).answer(readParams(request.query, now), now);
    }
    default:
      throw new Error(`No such request: ${request.path}`);
  }
}
