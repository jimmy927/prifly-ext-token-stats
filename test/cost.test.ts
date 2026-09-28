import { expect, test } from "bun:test";
import { Answerer, readParams } from "../answer";
import { decodeArchive, encodeArchive } from "../archive";
import { freshState, readText, type Usage } from "../parse";
import { costOf, familyOf, priceOf } from "../prices";
import { buildColumns } from "../store";

const AT = "2026-09-20T10:00:00Z";

/** An assistant line as Claude Code writes it, with the cache writes split by lifetime. */
const line = (id: string, model: string, usage: Record<string, unknown>) =>
  JSON.stringify({
    type: "assistant",
    timestamp: AT,
    requestId: `r${id}`,
    cwd: "/tmp/x",
    message: { id, model, usage },
  });

const opus = line("1", "claude-opus-5-5", {
  input_tokens: 1000,
  cache_creation_input_tokens: 3000,
  cache_creation: { ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 2000 },
  cache_read_input_tokens: 100_000,
  output_tokens: 500,
});
const haiku = line("2", "claude-haiku-4-5-20251001", {
  input_tokens: 2000,
  cache_creation_input_tokens: 1000,
  cache_creation: { ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 0 },
  cache_read_input_tokens: 50_000,
  output_tokens: 1000,
});
const fable = line("3", "claude-fable-5-1[1m]", {
  input_tokens: 10,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 200_000,
  output_tokens: 4000,
});
const mystery = line("4", "claude-nonesuch-9", {
  input_tokens: 1_000_000,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  output_tokens: 1_000_000,
});

const read = (...lines: string[]) => readText(freshState("a@x.com"), lines.join("\n"));

function answer(usages: Usage[], split: string) {
  const cols = buildColumns([{ sessionId: "s", title: "t", source: "local", repo: "r", usages }]);
  const params = readParams(
    { from: String(Date.parse(AT) - 3_600_000), to: String(Date.parse(AT) + 3_600_000), split },
    0,
  );
  return new Answerer(cols).answer(params);
}

test("a call costs its counts at its model's rates, 1-hour cache writes at the 1-hour rate", () => {
  const [o, h] = read(opus, haiku);
  expect(o?.cacheWrite1h).toBe(2000);
  // Opus 5.5: 1000×$4 + 1000×$5 (5m) + 2000×$8 (1h) + 100k×$0.20 + 500×$20, per million.
  expect(costOf(priceOf("claude-opus-5-5") ?? fail(), o ?? fail())).toBeCloseTo(0.055, 10);
  // Haiku 4.5, dated id: 2000×$1 + 1000×$1.25 + 50k×$0.10 + 1000×$5, per million.
  expect(familyOf("claude-haiku-4-5-20251001")).toBe("claude-haiku-4-5");
  expect(costOf(priceOf("claude-haiku-4-5-20251001") ?? fail(), h ?? fail())).toBeCloseTo(
    0.01325,
    10,
  );
  const total = answer(
    [o, h].filter((u) => u !== undefined),
    "none",
  );
  expect(total.series[0]?.total).toBeCloseTo(0.06825, 10);
  expect(total.rows[0]?.cost).toBeCloseTo(0.06825, 10);
});

test("a call with no 1-hour split, as archived before it was kept, pays the 5-minute rate", () => {
  const price = priceOf("claude-opus-5") ?? fail();
  const old = { input: 0, cacheWrite: 1_000_000, cacheRead: 0, output: 0 };
  expect(costOf(price, old)).toBe(6.25);
  expect(costOf(price, { ...old, cacheWrite1h: 1_000_000 })).toBe(10);
  const [o] = read(opus);
  const files = [
    { path: "/p/a.jsonl", sessionId: "a", parentId: null, title: "", usages: [o ?? fail()] },
  ];
  expect(decodeArchive(JSON.parse(JSON.stringify(encodeArchive(files))))).toEqual(files);
});

test("an unpriced model is reported, not costed at $0", () => {
  const result = answer(read(opus, mystery), "model");
  expect(priceOf("claude-nonesuch-9")).toBeNull();
  expect(result.unpriced).toEqual({ calls: 1, models: ["claude-nonesuch-9"] });
  expect(result.series.map((s) => s.key)).toEqual(["claude-opus-5-5"]);
  expect(result.rows.find((r) => r.key === "claude-nonesuch-9")?.calls).toBe(1);
  expect(answer(read(opus), "model").unpriced).toEqual({ calls: 0, models: [] });
});

test("cost is the default measure and splits by model with the dearest on top", () => {
  const result = answer(read(haiku, opus, fable), "model");
  expect(result.series.map((s) => s.key)).toEqual([
    "claude-fable-5-1[1m]",
    "claude-opus-5-5",
    "claude-haiku-4-5-20251001",
  ]);
  // Fable 5.1: 10×$10 + 200k×$0.25 + 4000×$50, per million.
  expect(result.series[0]?.total).toBeCloseTo(0.2501, 10);
  expect(result.rows.map((r) => r.key)).toEqual(result.series.map((s) => s.key));
});

function fail(): never {
  throw new Error("missing");
}
