import { expect, test } from "bun:test";
import { Answerer } from "../answer";
import type { LimitWindow } from "../history";
import type { Usage } from "../parse";
import { limitWeight, reconstruct, reconstructPast } from "../past";
import { buildColumns } from "../store";

const H = 3_600_000;
const W = 168 * H;

test("Opus 5.5 and every Fable count twice towards the limit, the rest once", () => {
  expect(limitWeight("claude-opus-5-5")).toBe(2);
  expect(limitWeight("claude-opus-5-5[1m]")).toBe(2);
  expect(limitWeight("claude-fable-5")).toBe(2);
  expect(limitWeight("claude-fable-5-1")).toBe(2);
  expect(limitWeight("claude-opus-5")).toBe(1);
  expect(limitWeight("claude-haiku-4-5-20251001")).toBe(1);
});

test("the hourly cost is weighted by model: a dollar of Opus 5.5 is two", () => {
  const at = Date.parse("2026-09-20T10:00:00Z");
  const usage = (ts: number, model: string): Usage => ({
    ts,
    account: "a@x.com",
    model,
    cwd: "/tmp/x",
    input: 0,
    cacheWrite: 0,
    cacheRead: 0,
    output: 1_000_000,
  });
  const cols = buildColumns([
    {
      sessionId: "s",
      title: "t",
      source: "local",
      repo: "r",
      // A million output tokens: $25 of Opus 5, $20 of Opus 5.5.
      usages: [usage(at + 60_000, "claude-opus-5"), usage(at + H + 60_000, "claude-opus-5-5")],
    },
  ]);
  const cost = new Answerer(cols).hourlyCost(at + 30 * 60_000, at + 3 * H, limitWeight);
  expect(cost.from).toBe(at);
  expect([...(cost.byAccount.get("a@x.com") ?? [])]).toEqual([25, 40, 0]);
});

test("a window's % rises with its cost from 0 at the reset to exactly the far end", () => {
  // $1, $0, $3 in three hours: a quarter of it by the first hour's end, flat through the second.
  expect(reconstruct(new Float64Array([1, 0, 3]), 0, 0, 3 * H, 100)).toEqual([
    [0, 0],
    [H, 25],
    [2 * H, 25],
    [3 * H, 100],
  ]);
  // Ends off the hour take their hour's cost pro rata; the last point is the end value, not a rounding of it.
  const off = reconstruct(new Float64Array([2, 2, 2]), 0, H / 2, 2.5 * H, 37);
  expect(off).toEqual([
    [H / 2, 0],
    [H, 9.25],
    [2 * H, 27.75],
    [2.5 * H, 37],
  ]);
  expect(reconstruct(new Float64Array(3), 0, 0, 3 * H, 100)).toBeNull();
});

const win = (email: string, start: number, hitAt: number | null): LimitWindow => ({
  email,
  start,
  end: start + W,
  hitAt,
  refusals: hitAt === null ? 0 : 1,
  lastRefusalAt: hitAt,
});

test("hit windows run 0 → 100 at the hit, the first reading's window is calibrated to it, the rest stay undrawn", () => {
  const cost = new Float64Array(W / H + 4);
  cost.set([1, 1, 2], 0); // a's first window: $4 before its hit at 3 h
  cost.set([3, 1], W / H); // a's second window: $4 before its first reading at W + 2 h
  const costB = new Float64Array(W / H + 4);
  costB.set([5], W / H);
  const past = reconstructPast(
    [win("a", 0, 3 * H), win("a", W, null), win("b", 0, null), win("b", W, null)],
    {
      from: 0,
      byAccount: new Map([
        ["a", cost],
        ["b", costB],
      ]),
    },
    new Map([
      ["a", [W + 2 * H, 40]],
      ["b", [W + H, 10]],
    ]),
    ["a", "b"],
    0,
    W + 3 * H,
    W + 3 * H,
  );
  const [hit, read, b] = past.curves;
  expect(past.curves).toHaveLength(3);
  // Shaped by its own cost, 100 at the hit minute, held there until its reset.
  expect(hit?.anchor).toBe("hit");
  expect(hit?.points).toEqual([
    [0, 0],
    [H, 25],
    [2 * H, 50],
    [3 * H, 100],
    [W, 100],
  ]);
  expect(read?.anchor).toBe("reading");
  expect(read?.points).toEqual([
    [W, 0],
    [W + H, 30],
    [W + 2 * H, 40],
  ]);
  // b's first window had no hit and no reading: no curve, so it stays hatched.
  expect(b?.email).toBe("b");
  expect(b?.start).toBe(W);
  // The pool only where both have a curve: from the reset at W to b's first reading.
  expect(past.pool).toEqual([
    [
      [W, 200],
      [W + H, 160],
    ],
  ]);
  expect(past.hourly.byAccount[0]?.[2]).toBe(50);
  expect(past.hourly.byAccount[1]?.[2]).toBeNull();
  expect(past.hourly.pool[2]).toBeNull();
  expect(past.hourly.pool[W / H]).toBe(200);
});

test("a hit before the first reading holds 100 until that reading, not past it", () => {
  const cost = new Float64Array(10);
  cost.set([2, 2], 0);
  const past = reconstructPast(
    [win("a", 0, 2 * H)],
    { from: 0, byAccount: new Map([["a", cost]]) },
    new Map([["a", [5 * H, 100]]]),
    ["a"],
    0,
    5 * H,
    6 * H,
  );
  expect(past.curves[0]?.points).toEqual([
    [0, 0],
    [H, 50],
    [2 * H, 100],
    [5 * H, 100],
  ]);
  expect(past.pool).toEqual([
    [
      [0, 100],
      [H, 50],
      [2 * H, 0],
      [5 * H, 0],
    ],
  ]);
});
