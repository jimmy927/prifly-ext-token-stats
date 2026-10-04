import { expect, test } from "bun:test";
import { Answerer, readParams } from "../answer";
import { decodeArchive, encodeArchive } from "../archive";
import { estimateTokens, freshState, ownWords, readText } from "../parse";
import { buildColumns } from "../store";

const MIN = 60_000;
const T0 = Date.parse("2026-10-05T10:00:00Z");
const at = (minutes: number) => new Date(T0 + minutes * MIN).toISOString();

const user = (minutes: number, content: unknown, cwd = "/src/x") =>
  JSON.stringify({ type: "user", timestamp: at(minutes), cwd, message: { role: "user", content } });
const reply = (minutes: number, id: string, model = "claude-opus-5-5", cwd = "/src/x") =>
  JSON.stringify({
    type: "assistant",
    timestamp: at(minutes),
    cwd,
    requestId: `r${id}`,
    message: { id, model, content: [], usage: { input_tokens: 1, output_tokens: 1 } },
  });

/** The minutes and tokens of the prompts a transcript's lines hold. */
function prompts(...lines: string[]) {
  const state = freshState("a@x.com");
  readText(state, lines.join("\n"));
  return state.human
    .filter((e) => e.tokens !== undefined)
    .map((e) => [(e.ts - T0) / MIN, e.tokens]);
}

test("what prifly adds to a prompt is not the reader's words", () => {
  const text = [
    "Make the chart taller.",
    "",
    '<prifly-intent kind="act" by="reader">The reader marked this message as an instruction.</prifly-intent>',
    '<prifly-paint width="1338" height="770" cols="183"/>',
    '<prifly-research>\nRead files; <prifly-reply kind="report"/> stays inside.\n</prifly-research>',
    "<pasted_content id=x>a log</pasted_content>",
    '<pasted_content id="8f83">\nanother log\n</pasted_content id="8f83">',
    "<system-reminder>x</system-reminder>",
  ].join("\n");
  expect(ownWords(text)).toBe("Make the chart taller.");
  // A session's brief from another session is all prifly's.
  expect(ownWords('<prifly-brief from-session="a" mode="x">Do the thing.</prifly-brief>')).toBe("");
});

test("only prompts the reader wrote carry tokens", () => {
  const words = "Why is the forecast empty on Mondays?";
  expect(
    prompts(
      user(0, words),
      reply(1, "m1"),
      user(2, "<command-name>/rename</command-name>"),
      user(3, [{ type: "text", text: "[Request interrupted by user]" }]),
      user(4, "<bash-input>ls</bash-input>"),
      user(5, 'Go ahead with: fix it\n\n<prifly-go-ahead reply="1" ask="fix it"/>'),
      user(6, "Give me a status report on this session.\n\n1. A table"),
      user(7, '<prifly-brief from-session="a">Build it.</prifly-brief>'),
      user(8, [{ type: "image", source: {} }]),
      user(9, [
        { type: "text", text: "<prifly-image>Image 1</prifly-image>" },
        { type: "text", text: "What is this?" },
      ]),
      // prifly's own reviewer sessions in /tmp are prompted by prifly.
      user(10, "This session is done. Can you confirm?", "/tmp/claude-1000/x"),
      user(11, "Review the drop.", "/tmp"),
    ),
  ).toEqual([
    [0, estimateTokens(words)],
    [9, estimateTokens("What is this?")],
  ]);
});

test("a queued prompt counts; a tool result never does", () => {
  const state = freshState();
  readText(
    state,
    [
      // Queued before any line names a folder: prifly starting a reviewer.
      JSON.stringify({
        type: "queue-operation",
        operation: "enqueue",
        timestamp: at(0),
        content: "# The agent's report",
      }),
      reply(0.2, "m1"),
      JSON.stringify({
        type: "queue-operation",
        operation: "enqueue",
        timestamp: at(0.5),
        content: "also this",
      }),
    ].join("\n"),
  );
  expect(state.human.map((e) => e.tokens)).toEqual([undefined, estimateTokens("also this")]);
});

test("tokens are characters over the fitted ratio: prose 2.9, code-like 2.33", () => {
  expect(estimateTokens("")).toBe(0);
  const prose = "a".repeat(290);
  expect(estimateTokens(prose)).toBe(100);
  const code = "f(x);".repeat(100);
  expect(estimateTokens(code)).toBe(Math.round(500 / 2.33));
});

test("a prompt is a row of the measures, on the account and model that answered it", () => {
  const state = freshState("a@x.com");
  const usages = readText(
    state,
    [
      reply(0, "m0", "claude-sonnet-5"),
      user(1, "a".repeat(290)),
      reply(2, "m1", "claude-fable-5-1"),
      user(3, "b".repeat(29)),
      reply(4, "m2", "claude-opus-5-5"),
      user(5, "the last, unanswered"),
    ].join("\n"),
  );
  const cols = buildColumns([
    { sessionId: "s1", title: "t", source: "local", repo: null, usages, human: state.human },
  ]);
  const answerer = new Answerer(cols);
  const ask = (metric: string, split: string) =>
    answerer.answer(
      readParams(
        { from: String(T0 - MIN), to: String(T0 + 10 * MIN), bucket: "60000", metric, split },
        T0,
      ),
      T0,
    );
  const byModel = ask("prompts", "model");
  expect(Object.fromEntries(byModel.series.map((s) => [s.key, s.total]))).toEqual({
    "claude-fable-5-1": 1,
    "claude-opus-5-5": 2,
  });
  const tokens = ask("promptTokens", "none");
  expect(tokens.series[0]?.total).toBe(100 + 10 + estimateTokens("the last, unanswered"));
  // Prompts are no calls: the calls and the simulator see only the three calls.
  const calls = ask("calls", "none");
  expect(calls.series[0]?.total).toBe(3);
  expect(calls.simulation.stretch.calls).toBe(3);
  expect(calls.unpriced.calls).toBe(0);
  const row = calls.rows[0];
  expect([row?.prompts, row?.promptTokens, row?.calls]).toEqual([3, tokens.series[0]?.total, 3]);
});

test("the archive keeps a prompt's tokens, and an event without them stays without", () => {
  const file = {
    path: "/p/a.jsonl",
    sessionId: "s",
    parentId: null,
    title: "t",
    usages: [],
    human: [
      { ts: 1, lead: 0, cwd: "/src/x", tokens: 12 },
      { ts: 2, lead: 0, cwd: "/src/x" },
    ],
  };
  expect(decodeArchive(JSON.parse(JSON.stringify(encodeArchive([file]))))?.[0]?.human).toEqual(
    file.human,
  );
});
