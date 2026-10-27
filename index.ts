/**
 * Token statistics: a window of prifly's own, opened from the status bar, of
 * how many tokens Claude Code used — over time, and split by account, model,
 * repository, folder, local/remote or session.
 *
 * Local sessions are read from `~/.claude/projects` by a worker thread
 * (`scan-worker.ts`), with prifly's copy of the other machines' on this
 * laptop — a WSL distribution's, for a host on Windows; remote ones through prifly's cloud access
 * (`remote.ts`). The window's page (`panel/`) asks `api/stats` for each view
 * and `api/status` for how far the reading has got.
 *
 * The Code view asks `api/code`: the same spend beside the lines of code each
 * repository's default branch gained (`git.ts`), read on the local scans that follow the Code view's first request.
 *
 * The Forecast view asks `api/forecast`: prifly's account limits, read every
 * 5 minutes into `readings.ts` and turned into runways by `forecast.ts`.
 */

import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Answerer, readParams } from "./answer";
import { applyScan } from "./archive";
import { codeAnswer, readCodeParams } from "./code-answer";
import { dailyBurn, type ForecastAnswer, forecast } from "./forecast";
import { GitLines } from "./git-cache";
import { limitHistory } from "./history";
import { limitWeight, reconstructPast, withPast } from "./past";
import type { ExtensionApi, PanelRequest } from "./prifly-api";
import { Readings } from "./readings";
import { RemoteSessions } from "./remote";
import type { FileOut, ScanProgress, ScanReply, ScanRequest } from "./scan-worker";
import { type Batch, buildColumns } from "./store";
import { checkoutOf, NO_REPO } from "./where";

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
  /** How far the scan under way has read; null between scans, and in one too short to tell. */
  progress: ScanProgress | null;
  scannedAt: number;
  request: ScanRequest;
  readings: Readings;
  log: ExtensionApi["log"];
  git: GitLines;
  gitReading: Promise<void> | null;
  /** Whether the Code view has asked this run: git is not read for a panel nobody opened. */
  codeAsked: boolean;
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
    ...(file.human === undefined ? {} : { human: file.human }),
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

/** Bring the lines of code up to date, for each repository with a checkout here; one read at a time. */
function readGit(state: Running): Promise<void> {
  if (state.gitReading !== null) return state.gitReading;
  const started = Date.now();
  const checkouts = new Map<string, string>();
  for (const name of answerer(state).values("repo")) {
    const path = name === NO_REPO ? null : checkoutOf(name);
    if (path !== null) checkouts.set(name, path);
  }
  state.gitReading = state.git
    .refresh(checkouts, state.log)
    .then(() => state.log("git_read", { repos: checkouts.size, ms: Date.now() - started }))
    .catch((error: unknown) => state.log("git_unreadable", { error: String(error) }))
    .finally(() => {
      state.gitReading = null;
    });
  return state.gitReading;
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
  state.progress = null;
  state.scannedAt = Date.now();
  log("scanned", reply.stats);
  state.scanning = null;
  state.resolveScan?.();
  state.resolveScan = null;
  if (state.codeAsked) void readGit(state);
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
  const readings = state.readings.all();
  const hits = [...state.local.values(), ...state.archived.values()].flatMap((f) => f.hits ?? []);
  // Each account's reset, its latest weekly reading's; none before its first.
  const latest = new Map<string, number | null>();
  for (const r of readings) if (r.label === "7d") latest.set(r.email, r.resetsAt);
  const resets = state.readings.accounts.map((a) => ({
    email: a.email,
    resetsAt: latest.get(a.email) ?? null,
  }));
  const history = limitHistory(hits, resets, now);
  // The minute each account ran out in the window it is in now: its forecast's rate when spent.
  const ranOut = new Map(
    history.windows.flatMap((w) =>
      w.hitAt !== null && w.end === latest.get(w.email) ? [[w.email, w.hitAt] as const] : [],
    ),
  );
  const found = forecast(readings, state.readings.accounts, now, ranOut);
  const emails = found.accounts.map((a) => a.email);
  const firsts = new Map(
    found.accounts.flatMap((a) =>
      a.measured[0] === undefined ? [] : ([[a.email, a.measured[0]]] as const),
    ),
  );
  const oldest = Math.min(history.from, ...history.windows.map((w) => w.start));
  const cost = answerer(state).hourlyCost(oldest, now, limitWeight);
  const past = reconstructPast(
    history.windows,
    cost,
    firsts,
    emails,
    history.from,
    found.grid.from,
    now,
  );
  // Each account's first weekly reading: its days are reconstructed before it, measured after.
  const readFrom = new Map<string, number>();
  for (const r of readings) {
    if (r.label === "7d" && !readFrom.has(r.email)) readFrom.set(r.email, r.at);
  }
  const measured = dailyBurn(readings, now, minutes * 60_000);
  return {
    supported: state.accounts !== null,
    newestAt: state.readings.newestAt,
    ...found,
    daily: withPast(measured, past.curves, emails, readFrom, now),
    history,
    past,
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
    progress: null,
    scannedAt: 0,
    request: {
      type: "scan",
      root: join(homedir(), ".claude", "projects"),
      cacheFile: join(api.folder, "cache", "local.sqlite"),
      legacyCacheFile: join(api.folder, "cache", "local.json"),
      archiveFile: join(api.folder, "cache", "archive.json"),
      // `<data>/extensions/<this>`: prifly keeps its copies under `<data>/machine-history`.
      mirrors: join(dirname(dirname(api.folder)), "machine-history"),
    },
    readings: new Readings(join(api.folder, "cache", "readings.jsonl")),
    log: api.log,
    git: new GitLines(join(api.folder, "cache", "git.json")),
    gitReading: null,
    codeAsked: false,
    // A host older than the contract's `accounts()` has no such function.
    accounts: typeof api.accounts === "function" ? () => api.accounts() : null,
  };
  worker.onmessage = (event: MessageEvent<ScanReply | ScanProgress>) => {
    if (event.data.type === "progress") state.progress = event.data;
    else received(state, event.data, api.log);
  };
  worker.onerror = (event) => {
    api.log("scan_failed", { error: event.message });
    state.scanning = null;
    state.progress = null;
    state.resolveScan?.();
  };
  running = state;
  state.readings.load(Date.now());
  void state.git.load();
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
    progress: state.progress,
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
      await readGit(state);
      return status(state);
    case "forecast":
      return forecastAnswer(state, request.query);
    case "code": {
      if (state.lastScan === null) await scanLocal(state);
      state.codeAsked = true;
      // With a history on hand the read is incremental, and cheap where nothing moved: wait for
      // it, so the answer is current. Without one it is long: answer "not ready" and let the page retry.
      if (state.git.ready()) await readGit(state);
      else void readGit(state);
      return codeAnswer(answerer(state), state.git, readCodeParams(request.query, Date.now()));
    }
    case "stats": {
      if (state.lastScan === null) await scanLocal(state);
      const now = Date.now();
      return answerer(state).answer(readParams(request.query, now), now);
    }
    default:
      throw new Error(`No such request: ${request.path}`);
  }
}
