import { expect, test } from "bun:test";
import { Answerer, readParams } from "../answer";
import type { Usage } from "../parse";
import { buildColumns } from "../store";
import { modelTones, modelVersion } from "../tones";

const AT = Date.parse("2026-09-20T10:00:00Z");

test("a model's family and version come from its id, dates and [1m] aside", () => {
  expect(modelVersion("claude-opus-5-5")).toEqual({ family: "opus", version: [5, 5] });
  expect(modelVersion("claude-opus-5")).toEqual({ family: "opus", version: [5, 0] });
  expect(modelVersion("claude-fable-5-1[1m]")).toEqual({ family: "fable", version: [5, 1] });
  expect(modelVersion("claude-haiku-4-5-20251001")).toEqual({ family: "haiku", version: [4, 5] });
  expect(modelVersion("claude-3-5-haiku")).toEqual({ family: "haiku", version: [3, 5] });
  expect(modelVersion("claude-mythos-5")).toBeNull();
  expect(modelVersion("unknown")).toBeNull();
});

test("the newest version of a family wears the first shade, older ones the next", () => {
  const names = [
    "claude-opus-4-8",
    "claude-fable-5",
    "claude-opus-5-5",
    "claude-sonnet-5",
    "claude-opus-5",
    "claude-fable-5-1",
    "claude-fable-5-1[1m]",
    "claude-haiku-4-5-20251001",
    "claude-nonesuch-9",
  ];
  expect(modelTones(names)).toEqual([
    "opus-2",
    "fable-1",
    "opus-0",
    "sonnet-0",
    "opus-1",
    "fable-0",
    "fable-0",
    "haiku-0",
    null,
  ]);
  // A fourth Opus has no shade left and takes the categorical palette.
  expect(modelTones([...names, "claude-opus-4-1"]).at(-1)).toBeNull();
});

const usage = (model: string, output: number): Usage => ({
  ts: AT,
  account: "a@x.com",
  model,
  cwd: "/tmp/x",
  input: 0,
  cacheWrite: 0,
  cacheRead: 0,
  output,
});

test("a model keeps its shade whatever the filter lets through", () => {
  const cols = buildColumns([
    {
      sessionId: "s",
      title: "t",
      source: "local",
      repo: "r",
      usages: [
        usage("claude-opus-4-8", 9000),
        usage("claude-opus-5-5", 10),
        usage("claude-opus-5", 500),
        usage("claude-fable-5-1", 100),
      ],
    },
  ]);
  const answerer = new Answerer(cols);
  const ask = (models: string[]) =>
    answerer.answer(
      readParams(
        {
          from: String(AT - 3_600_000),
          to: String(AT + 3_600_000),
          split: "model",
          filters: JSON.stringify(models.length > 0 ? { model: models } : {}),
        },
        0,
      ),
    );
  const toneOf = (models: string[], key: string) => ({
    series: ask(models).series.find((s) => s.key === key)?.tone,
    row: ask(models).rows.find((r) => r.key === key)?.tone,
  });
  const whole = { series: "opus-0", row: "opus-0" };
  expect(toneOf([], "claude-opus-5-5")).toEqual(whole);
  expect(toneOf(["claude-opus-5-5"], "claude-opus-5-5")).toEqual(whole);
  expect(toneOf(["claude-opus-5-5", "claude-fable-5-1"], "claude-opus-5-5")).toEqual(whole);
  expect(toneOf(["claude-opus-4-8"], "claude-opus-4-8")).toEqual({
    series: "opus-2",
    row: "opus-2",
  });
  // Other splits keep the categorical palette.
  const byAccount = answerer.answer(
    readParams({ from: String(AT - 3_600_000), to: String(AT + 3_600_000), split: "account" }, 0),
  );
  expect(byAccount.series.map((s) => s.tone)).toEqual([null]);
});
