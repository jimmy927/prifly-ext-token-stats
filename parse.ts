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
  cacheWrite: number;
  cacheRead: number;
  output: number;
};

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
};

export const UNKNOWN = "not recorded";

const EMAIL = /The user's email address is ([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]+)/;
const RECENT = 64;

export function freshState(account = ""): ReaderState {
  return { account, cwd: "", title: "", prompt: "", segments: [], recent: [] };
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
  return callOf(state, line, ts, fixed);
}

/** An assistant line's call, once per call id. */
function callOf(
  state: ReaderState,
  line: Line,
  ts: number,
  fixed: ((ts: number) => string) | null,
): Usage | null {
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
    account: (fixed === null ? state.account : fixed(ts)) || UNKNOWN,
    model: model || "unknown",
    cwd: state.cwd,
    input: num(usage["input_tokens"]),
    cacheWrite: num(usage["cache_creation_input_tokens"]),
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
