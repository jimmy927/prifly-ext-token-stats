/**
 * Reading token usage out of Claude Code transcripts.
 *
 * Every assistant line carries the API's `usage` for the call that produced
 * it. Claude Code writes one line per content block, all with the same
 * message id and the same usage, so a call is counted once by its id.
 *
 * Which account made the call is not on the line. Since early September 2026
 * Claude Code writes a `session_context` attachment whenever a session starts
 * or is resumed, and it names the logged-in email; every call after it, up to
 * the next one, is that account's. A switch made mid-session therefore shows
 * at the next resume, not at the login itself.
 */

/** One API call: when, on whose account, with what, and how many tokens. */
export type Usage = {
  ts: number;
  account: string;
  model: string;
  cwd: string;
  input: number;
  /** All cache writes, both lifetimes. */
  cacheWrite: number;
  /**
   * The part of `cacheWrite` written at the 1-hour rate, from the API's
   * `usage.cache_creation.ephemeral_1h_input_tokens`. Absent on calls read
   * before this was kept (the archive, cached cloud sessions): see `costOf`.
   */
  cacheWrite1h?: number;
  cacheRead: number;
  output: number;
};

/**
 * A call the API refused because the account's weekly limit was used up:
 * Claude Code writes it as a synthetic assistant line with `quotaLimits`
 * (`rateLimitType` "seven_day", `status` "rejected") and the reset in epoch
 * seconds. `account` is the transcript's account at that line, which lags a
 * switch made mid-session; `history.ts` settles the owner by `resetsAt`.
 */
export type LimitHit = { ts: number; account: string; resetsAt: number };

/** When a session's account changed, oldest first: how a sub-agent's calls are attributed. */
export type Segment = { ts: number; account: string };

/** What a reader keeps between chunks of the same file. */
export type ReaderState = {
  account: string;
  cwd: string;
  title: string;
  prompt: string;
  segments: Segment[];
  /** The last few call ids, enough to drop a call's repeated content-block lines. */
  recent: string[];
  /** Files the transcript wrote since the scan last took them: see `writesOf`. */
  written: string[];
  /** Weekly-limit refusals since the scan last took them. */
  hits: LimitHit[];
};

export const UNKNOWN = "not recorded";

const EMAIL = /The user's email address is ([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]+)/;
const RECENT = 64;

export function freshState(account = ""): ReaderState {
  return {
    account,
    cwd: "",
    title: "",
    prompt: "",
    segments: [],
    recent: [],
    written: [],
    hits: [],
  };
}

/** The tools that write a file, and the input field that names it. */
const WRITE_TOOLS: Record<string, string> = {
  Edit: "file_path",
  MultiEdit: "file_path",
  Write: "file_path",
  NotebookEdit: "notebook_path",
};

/**
 * The files an assistant line's tool calls write, one entry per call. What a
 * Bash command writes is not guessed at: only these tools name their file.
 */
export function writesOf(line: Line): string[] {
  const content = asRecord(line["message"])?.["content"];
  if (!Array.isArray(content)) return [];
  return content.flatMap((raw) => {
    const block = asRecord(raw);
    const field = WRITE_TOOLS[str(block?.["name"])];
    if (block?.["type"] !== "tool_use" || field === undefined) return [];
    const path = str(asRecord(block["input"])?.[field]);
    return path.startsWith("/") ? [path] : [];
  });
}

type Line = Record<string, unknown>;

const asRecord = (value: unknown): Line | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Line) : null;
const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
const str = (value: unknown) => (typeof value === "string" ? value : "");

/**
 * Lines worth parsing: the rest are skipped without `JSON.parse`, which is
 * most of the bytes. A user line only while the first prompt is still wanted.
 */
export function interesting(line: string, wantPrompt: boolean): boolean {
  return (
    line.includes('"usage"') ||
    line.includes("session_context") ||
    line.includes('"custom-title"') ||
    line.includes('"quotaLimits"') ||
    (wantPrompt && line.includes('"type":"user"') && !line.includes('"toolUseResult"'))
  );
}

/** The first line of the first prompt the reader typed, for a session with no title. */
function promptOf(line: Line): string {
  if (line["isMeta"] === true) return "";
  const content = asRecord(line["message"])?.["content"];
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? str(content.map(asRecord).find((block) => block?.["type"] === "text")?.["text"])
        : "";
  const first = text.trim().split("\n")[0] ?? "";
  return first.startsWith("<") ? "" : first.slice(0, 90);
}

function accountOf(line: Line): string {
  const attachment = asRecord(line["attachment"]);
  if (line["type"] !== "attachment" || attachment?.["type"] !== "session_context") return "";
  return EMAIL.exec(JSON.stringify(attachment))?.[1] ?? "";
}

/**
 * Feed one parsed transcript line; the call it records, or null. `fixed` is
 * the account every call is charged to regardless of the line — a cloud
 * session's, or a sub-agent's parent's at that moment.
 */
export function readLine(
  state: ReaderState,
  line: Line,
  fixed: ((ts: number) => string) | null = null,
): Usage | null {
  const cwd = str(line["cwd"]);
  if (cwd !== "") state.cwd = cwd;
  if (line["type"] === "custom-title") state.title = str(line["customTitle"]);
  if (line["type"] === "user" && state.prompt === "") state.prompt = promptOf(line);
  const ts = Date.parse(str(line["timestamp"]));
  const account = accountOf(line);
  if (account !== "" && account !== state.account) {
    state.account = account;
    state.segments.push({ ts: Number.isNaN(ts) ? 0 : ts, account });
  }
  if (line["type"] !== "assistant" || Number.isNaN(ts)) return null;
  // Each content block has a line of its own: a tool call is on one the call's id skips.
  state.written.push(...writesOf(line));
  const charged = (fixed === null ? state.account : fixed(ts)) || UNKNOWN;
  const hit = hitOf(line, ts, charged);
  if (hit !== null) state.hits.push(hit);
  return callOf(state, line, ts, charged);
}

/** The weekly-limit refusal an assistant line records, or null. */
function hitOf(line: Line, ts: number, account: string): LimitHit | null {
  const quota = asRecord(line["quotaLimits"]);
  if (quota?.["rateLimitType"] !== "seven_day" || quota["status"] !== "rejected") return null;
  const resetsAt = num(quota["resetsAt"]);
  return resetsAt === 0 ? null : { ts, account, resetsAt: resetsAt * 1000 };
}

/** An assistant line's call, once per call id. */
function callOf(state: ReaderState, line: Line, ts: number, account: string): Usage | null {
  const message = asRecord(line["message"]);
  const usage = asRecord(message?.["usage"]);
  if (message === null || usage === null) return null;
  const model = str(message["model"]);
  if (model === "<synthetic>") return null;
  const id = `${str(message["id"])}/${str(line["requestId"])}`;
  if (id !== "/" && state.recent.includes(id)) return null;
  state.recent.push(id);
  if (state.recent.length > RECENT) state.recent.shift();
  return {
    ts,
    account,
    model: model || "unknown",
    cwd: state.cwd,
    input: num(usage["input_tokens"]),
    cacheWrite: num(usage["cache_creation_input_tokens"]),
    cacheWrite1h: num(asRecord(usage["cache_creation"])?.["ephemeral_1h_input_tokens"]),
    cacheRead: num(usage["cache_read_input_tokens"]),
    output: num(usage["output_tokens"]),
  };
}

/** Feed a chunk of JSONL text: the calls in it, in order. */
export function readText(
  state: ReaderState,
  text: string,
  fixed: ((ts: number) => string) | null = null,
): Usage[] {
  const out: Usage[] = [];
  for (const raw of text.split("\n")) {
    if (!interesting(raw, state.prompt === "")) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // A line cut off mid-write, or not ours: the next scan reads it whole.
      continue;
    }
    const line = asRecord(parsed);
    const usage = line === null ? null : readLine(state, line, fixed);
    if (usage !== null) out.push(usage);
  }
  return out;
}

/** The account a session was on at `ts`, by its segments; "" before the first. */
export function accountAt(segments: readonly Segment[], ts: number): string {
  let found = "";
  for (const segment of segments) {
    if (segment.ts > ts) break;
    found = segment.account;
  }
  return found;
}
