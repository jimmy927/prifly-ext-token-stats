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
 *
 * It also notes the moments the reader acted (`HumanEvent`), which the
 * active-time estimate is made of (`presence.ts`).
 */

import { LEAD_MAX } from "./presence";

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

/**
 * A moment the reader demonstrably acted in a session (`humanOf`): the input
 * of the active-time estimate (`presence.ts`). `lead` is the time since the
 * session's previous assistant line, at most `LEAD_MAX`; `cwd` the session's
 * folder then, which places it in a repository as a call made there is.
 */
export type HumanEvent = { ts: number; lead: number; cwd: string };

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
  /** When the last assistant line was written, 0 before one: an event's lead. */
  replied: number;
  /** The AskUserQuestion calls not answered yet, by tool_use id: their answer is the reader's. */
  asks: string[];
  /** The reader's own events since the scan last took them. */
  human: HumanEvent[];
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
    replied: 0,
    asks: [],
    human: [],
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

/** What a tool result says when the reader refused the call: a cheap test for `interesting`. */
const REFUSED = "doesn't want to proceed";
/** How Claude Code's own refusal result begins. */
const REFUSAL = "The user doesn't want to proceed with this tool use";

/**
 * Whether a tool result is Claude Code's refusal: an error whose text begins
 * with it. A result that only quotes the words (a Read or Grep of a file that
 * holds them) is not.
 */
function refusal(block: Line): boolean {
  if (block["is_error"] !== true) return false;
  const content = block["content"];
  const text = Array.isArray(content)
    ? str(content.map(asRecord).find((part) => part?.["type"] === "text")?.["text"])
    : str(content);
  return text.trimStart().startsWith(REFUSAL);
}

/**
 * Lines worth parsing: the rest are skipped without `JSON.parse`, which is
 * most of the bytes. Of user lines, a tool result — most of them, and the
 * biggest — only when it may be the reader's own: a refused call, or the
 * answer to a question still open (`humanOf`). A queued prompt only when
 * queued, not when taken off the queue.
 */
export function interesting(line: string, state: ReaderState): boolean {
  if (
    line.includes('"usage"') ||
    line.includes("session_context") ||
    line.includes('"custom-title"') ||
    line.includes('"quotaLimits"')
  ) {
    return true;
  }
  if (line.includes('"queue-operation"')) return line.includes('"enqueue"');
  if (!line.includes('"type":"user"')) return false;
  if (!line.includes('"toolUseResult"')) return true;
  return line.includes(REFUSED) || state.asks.some((id) => line.includes(id));
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

/**
 * What a user line or a queued prompt that begins so is: Claude Code or
 * prifly speaking, not the reader typing.
 */
const NOT_TYPED = [
  "<task-notification",
  "<local-command-stdout",
  "<local-command-caveat",
  "<bash-stdout",
  "<bash-stderr",
  "Caveat:",
  "<prifly-notice",
  "<system-reminder",
];

/** Whether a prompt's text is the reader's: something, and not in a machine's voice. */
function typed(text: string): boolean {
  const start = text.trimStart();
  return start !== "" && !NOT_TYPED.some((prefix) => start.startsWith(prefix));
}

/** The most AskUserQuestion calls kept waiting for an answer: one abandoned must not pile up. */
const ASKS = 16;

/**
 * Whether a line is the reader acting: a prompt typed (a slash command and
 * an interrupt included), one queued while Claude worked — those have no
 * user line of their own — the answer to an AskUserQuestion, or a tool call
 * refused. Not a meta line, a compaction's summary, a sub-agent's line
 * (a sidechain), a tool's result, or anything `NOT_TYPED` begins. An
 * enqueue with no text is the queue recording a prompt whose own user line
 * follows at once.
 */
function humanOf(state: ReaderState, line: Line): boolean {
  if (line["type"] === "queue-operation") {
    return line["operation"] === "enqueue" && typed(str(line["content"]));
  }
  const machine =
    line["isMeta"] === true || line["isCompactSummary"] === true || line["isSidechain"] === true;
  if (line["type"] !== "user" || machine) return false;
  const content = asRecord(line["message"])?.["content"];
  if (typeof content === "string") return typed(content);
  return Array.isArray(content) && blocksAreHuman(state, line, content.map(asRecord));
}

/** Whether a user line's content blocks are the reader's: `humanOf` for a list of blocks. */
function blocksAreHuman(state: ReaderState, line: Line, blocks: (Line | null)[]): boolean {
  for (const block of blocks) {
    if (block?.["type"] !== "tool_result") continue;
    const at = state.asks.indexOf(str(block["tool_use_id"]));
    if (at >= 0) {
      state.asks.splice(at, 1);
      return true;
    }
    if (refusal(block)) return true;
  }
  if (line["toolUseResult"] !== undefined) return false;
  const text = blocks.find((block) => block?.["type"] === "text");
  // A pasted picture with no words is typed too.
  if (text === undefined) return blocks.some((block) => block?.["type"] === "image");
  return typed(str(text?.["text"]));
}

/** The AskUserQuestion calls an assistant line makes, remembered until answered. */
function noteAsks(state: ReaderState, line: Line): void {
  const content = asRecord(line["message"])?.["content"];
  if (!Array.isArray(content)) return;
  for (const raw of content) {
    const block = asRecord(raw);
    if (block?.["type"] !== "tool_use" || block["name"] !== "AskUserQuestion") continue;
    state.asks.push(str(block["id"]));
    if (state.asks.length > ASKS) state.asks.shift();
  }
}

/** An event's lead: the time since the session's last assistant line, at most `LEAD_MAX`. */
const leadOf = (state: ReaderState, ts: number) =>
  state.replied === 0 ? LEAD_MAX : Math.min(Math.max(ts - state.replied, 0), LEAD_MAX);

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
  if (Number.isNaN(ts)) return null;
  if (humanOf(state, line)) state.human.push({ ts, lead: leadOf(state, ts), cwd: state.cwd });
  if (line["type"] !== "assistant") return null;
  state.replied = ts;
  noteAsks(state, line);
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
    if (!interesting(raw, state)) continue;
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
