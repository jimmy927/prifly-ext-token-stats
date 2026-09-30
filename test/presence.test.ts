import { expect, test } from "bun:test";
import { Answerer } from "../answer";
import { freshState, readText } from "../parse";
import {
  GAP_WEIGHTS,
  gapWeight,
  LEAD_MAX,
  presenceStretches,
  spreadHours,
  type TimelineEvent,
} from "../presence";
import { type Batch, buildColumns } from "../store";

const MIN = 60_000;
const HOUR = 60 * MIN;
const T0 = Date.parse("2026-09-28T10:00:00Z");
const at = (minutes: number) => new Date(T0 + minutes * MIN).toISOString();

const user = (minutes: number, content: unknown, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: "user",
    timestamp: at(minutes),
    cwd: "/src/x",
    message: { role: "user", content },
    ...extra,
  });
const reply = (minutes: number, id: string, tools: { id: string; name: string }[] = []) =>
  JSON.stringify({
    type: "assistant",
    timestamp: at(minutes),
    cwd: "/src/x",
    requestId: `r${id}`,
    message: {
      id,
      model: "claude-opus-5-5",
      content: tools.map((t) => ({ type: "tool_use", id: t.id, name: t.name, input: {} })),
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  });
const result = (minutes: number, toolUseId: string, content: string) =>
  user(minutes, [{ type: "tool_result", tool_use_id: toolUseId, content }], {
    toolUseResult: { any: "thing" },
  });
const queue = (minutes: number, operation: string, content?: string) =>
  JSON.stringify({
    type: "queue-operation",
    operation,
    timestamp: at(minutes),
    ...(content === undefined ? {} : { content }),
  });

/** The minutes of the events a transcript's lines hold, and their leads in minutes. */
function events(...lines: string[]) {
  const state = freshState("a@x.com");
  readText(state, lines.join("\n"));
  return state.human.map((e) => [(e.ts - T0) / MIN, e.lead / MIN]);
}

test("typed prompts, slash commands and interrupts are the reader's; machine voices are not", () => {
  expect(
    events(
      user(0, "fix the bug"),
      reply(1, "m1"),
      user(2, "<command-name>/rename</command-name>"),
      user(3, [{ type: "text", text: "[Request interrupted by user]" }]),
      user(4, "<task-notification>done</task-notification>"),
      user(5, "<local-command-stdout>x</local-command-stdout>"),
      user(6, "Caveat: the messages below"),
      user(7, "<prifly-notice>x</prifly-notice>"),
      user(8, "  <system-reminder>x</system-reminder>"),
      user(9, "meta", { isMeta: true }),
      user(10, "This session is being continued", { isCompactSummary: true }),
      user(11, "a sub-agent's prompt", { isSidechain: true }),
      user(12, [{ type: "image", source: {} }]),
    ),
  ).toEqual([
    [0, 2],
    [2, 1],
    [3, 2],
    [12, 2],
  ]);
});

test("an answer to AskUserQuestion and a refused call count; other tool results do not", () => {
  const lines = [
    reply(0, "m1", [
      { id: "toolu_ask", name: "AskUserQuestion" },
      { id: "toolu_bash", name: "Bash" },
    ]),
    result(0.5, "toolu_bash", "ok"),
    result(3, "toolu_ask", 'The user answered: "a"'),
    // Answered once: a second result for it is not another answer.
    result(4, "toolu_ask", "again"),
    reply(5, "m2", [{ id: "toolu_edit", name: "Edit" }]),
    result(5.5, "toolu_edit", "The user doesn't want to proceed with this tool use."),
  ];
  expect(events(...lines)).toEqual([
    [3, 2],
    [5.5, 0.5],
  ]);
  // The question is remembered across chunks: its answer may come in the next scan.
  const state = freshState();
  readText(state, lines.slice(0, 2).join("\n"));
  expect(state.human).toEqual([]);
  readText(state, lines.slice(2, 3).join("\n"));
  expect(state.human.map((e) => e.ts)).toEqual([T0 + 3 * MIN]);
});

test("a prompt queued while Claude worked counts, not its dequeue or an empty enqueue", () => {
  expect(
    events(
      reply(0, "m1"),
      queue(0.5, "enqueue", "also do this"),
      queue(0.6, "enqueue"),
      queue(0.7, "enqueue", "<task-notification>x</task-notification>"),
      queue(1, "dequeue", "also do this"),
      queue(1.5, "remove", "also do this"),
    ),
  ).toEqual([[0.5, 0.5]]);
});

test("a lead is the time since the session's last assistant line, at most two minutes", () => {
  const state = freshState();
  readText(state, [user(0, "first"), reply(1, "m1")].join("\n"));
  // A later chunk: the reply it measures from was read in the earlier one.
  readText(state, [user(1.25, "quick"), reply(2, "m2"), user(30, "later")].join("\n"));
  expect(state.human.map((e) => e.lead)).toEqual([LEAD_MAX, 0.25 * MIN, LEAD_MAX]);
  expect(state.human.map((e) => e.cwd)).toEqual(["/src/x", "/src/x", "/src/x"]);
});

test("the gap weights are the calibrated table", () => {
  expect(GAP_WEIGHTS.map(([upTo, w]) => [upTo / MIN, w])).toEqual([
    [2, 1],
    [5, 0.97],
    [10, 0.72],
    [15, 0.32],
    [30, 0.09],
    [60, 0.03],
  ]);
  expect(gapWeight(0)).toBe(1);
  expect(gapWeight(2 * MIN)).toBe(1);
  expect(gapWeight(2 * MIN + 1)).toBe(0.97);
  expect(gapWeight(10 * MIN)).toBe(0.72);
  expect(gapWeight(45 * MIN)).toBe(0.03);
  expect(gapWeight(60 * MIN + 1)).toBe(0);
});

/** The present minutes each owner gets. */
function minutesByOwner(list: TimelineEvent[]): Map<number, number> {
  const out = new Map<number, number>();
  for (const s of presenceStretches(list)) {
    out.set(s.owner, (out.get(s.owner) ?? 0) + ((s.to - s.from) * s.weight) / MIN);
  }
  return out;
}

const ev = (minutes: number, lead: number, owner: number): TimelineEvent => ({
  ts: T0 + minutes * MIN,
  lead: lead * MIN,
  owner,
});

test("sessions share one timeline, and a stretch goes to the session replied to next", () => {
  // Session 0 at 0 and 20, session 1 at 4 and 7: the reader switched between them.
  const found = minutesByOwner([ev(20, 1, 0), ev(0, 2, 0), ev(4, 1, 1), ev(7, 0.5, 1)]);
  // 0: its own lead (2). 4: the 4-minute gap, 1 of it lead, 3 at 0.97. 7: 3 minutes, 0.5
  // lead, 2.5 at 0.97. 20: 13 minutes, 1 lead, 12 at 0.32.
  expect(found.get(1)).toBeCloseTo(1 + 3 * 0.97 + 0.5 + 2.5 * 0.97, 9);
  expect(found.get(0)).toBeCloseTo(2 + 1 + 12 * 0.32, 9);
});

test("leads never count twice, and one reaching past the event before it covers that gap too", () => {
  // Two events 30 s apart, both with a two-minute lead: 2.5 minutes, not 4, and what is
  // before the first event is the first one's.
  const close = minutesByOwner([ev(0, 2, 0), ev(0.5, 2, 1)]);
  expect(close.get(0)).toBeCloseTo(2, 9);
  expect(close.get(1)).toBeCloseTo(0.5, 9);
  // A long lead reaching past a short one's event: the gap before that event is covered whole.
  const reaching = minutesByOwner([ev(0, 0, 0), ev(3, 0, 1), ev(4, 2, 2)]);
  expect(reaching.get(1)).toBeCloseTo(1 + 2 * 0.97, 9);
  expect(reaching.get(2)).toBeCloseTo(1, 9);
  // Over an hour apart: only the leads count.
  const apart = minutesByOwner([ev(0, 2, 0), ev(90, 2, 1)]);
  expect(apart.get(0)).toBeCloseTo(2, 9);
  expect(apart.get(1)).toBeCloseTo(2, 9);
  expect(presenceStretches([])).toEqual([]);
});

test("present time spreads over the buckets it overlaps", () => {
  const values = [0, 0, 0];
  spreadHours(values, T0, HOUR, T0 - HOUR, T0 + 1.5 * HOUR, 0.5);
  expect(values).toEqual([0.5, 0.25, 0]);
  spreadHours(values, T0, HOUR, T0 + 2.5 * HOUR, T0 + 9 * HOUR, 1);
  expect(values).toEqual([0.5, 0.25, 0.5]);
});

test("active hours go to the repository of the session replied to next", () => {
  const batch = (sessionId: string, repo: string, minutes: number[]): Batch => ({
    sessionId,
    title: "",
    source: "remote",
    repo,
    usages: [],
    human: minutes.map((m) => ({ ts: T0 + m * MIN, lead: 0, cwd: "/src/y" })),
  });
  const answerer = new Answerer(
    buildColumns([batch("s1", "alpha", [0, 50, 70]), batch("s2", "beta", [55, 72])]),
  );
  const hours = answerer.activeHours(T0, HOUR, 2);
  // alpha: 0→50 is 50 minutes at 0.03; 55→70 is 15 at 0.32. beta: 50→55 at 0.97, 70→72 at 1.
  const alpha = hours.get("alpha") ?? [];
  const beta = hours.get("beta") ?? [];
  expect(alpha[0]).toBeCloseTo((50 * 0.03 + 5 * 0.32) / 60, 9);
  expect(alpha[1]).toBeCloseTo((10 * 0.32) / 60, 9);
  expect(beta[0]).toBeCloseTo((5 * 0.97) / 60, 9);
  expect(beta[1]).toBeCloseTo(2 / 60, 9);
});

test("a session in no repository credits its time to the repositories it wrote into", () => {
  const answerer = new Answerer(
    buildColumns([
      {
        sessionId: "s1",
        title: "",
        source: "local",
        repo: null,
        usages: [],
        writes: { alpha: 3, beta: 1 },
        human: [
          { ts: T0, lead: 0, cwd: "/tmp" },
          { ts: T0 + 4 * MIN, lead: 0, cwd: "/tmp" },
        ],
      },
    ]),
  );
  const hours = answerer.activeHours(T0, HOUR, 1);
  expect(hours.get("alpha")?.[0]).toBeCloseTo((0.75 * 4 * 0.97) / 60, 9);
  expect(hours.get("beta")?.[0]).toBeCloseTo((0.25 * 4 * 0.97) / 60, 9);
});
