import { expect, test } from "bun:test";
import { Answerer } from "../answer";
import type { LimitWindow } from "../history";
import type { Usage } from "../parse";
import {
  estimate,
  limitWeight,
  type PastCurve,
  perFullWeek,
  reconstruct,
  reconstructPast,
  withPast,
} from "../past";
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

test("hit windows run 0 → 100 at the hit, the first reading's window is calibrated to it, the rest are estimated", () => {
  const cost = new Float64Array(W / H + 4);
  cost.set([1, 1, 2], 0); // a's first window: $4 before its hit at 3 h
  cost.set([3, 1], W / H); // a's second window: $4 before its first reading at W + 2 h
  const costB = new Float64Array(W / H + 4);
  costB.set([0, 2], 0); // b's first window never ran out: $2 of the $4 a week to 100% costs
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
  const [hit, read, guess, b] = past.curves;
  expect(past.curves).toHaveLength(4);
  expect(past.per100).toBe(4);
  expect(past.band).toBe(0.3);
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
  // b's first window had no hit and no reading: its cost over a's $4 to 100%, with a ±30% band, to its reset.
  expect(guess?.anchor).toBe("estimate");
  expect(guess?.points.slice(0, 3)).toEqual([
    [0, 0],
    [H, 0],
    [2 * H, 50],
  ]);
  expect(guess?.points.at(-1)).toEqual([W, 50]);
  expect(guess?.band?.[2]).toEqual([2 * H, 35, 65]);
  expect(b?.anchor).toBe("reading");
  expect(b?.start).toBe(W);
  // The pool from the first reset on, where both now have a curve, to b's first reading: estimated while b's share is.
  expect(past.pool).toHaveLength(1);
  const [run] = past.pool;
  expect(run?.points.slice(0, 3)).toEqual([
    [0, 200],
    [H, 175],
    [2 * H, 100],
  ]);
  expect(run?.range[2]).toEqual([85, 115]);
  expect(run?.estimated.slice(0, 3)).toEqual([true, true, true]);
  expect(run?.points.at(-1)).toEqual([W + H, 160]);
  expect(run?.estimated.at(-1)).toBe(false);
  expect(past.hourly.byAccount[0]?.[2]).toBe(50);
  expect(past.hourly.byAccount[1]?.[2]).toBe(50);
  expect(past.hourly.range[0]?.[2]).toBeNull();
  expect(past.hourly.range[1]?.[2]).toEqual([35, 65]);
  expect(past.hourly.pool[2]).toBe(100);
  expect(past.hourly.poolRange[2]).toEqual([85, 115]);
  expect(past.hourly.pool[W / H]).toBe(200);
  expect(past.hourly.poolRange[W / H]).toBeNull();
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
  expect(past.pool.map((r) => r.points)).toEqual([
    [
      [0, 100],
      [H, 50],
      [2 * H, 0],
      [5 * H, 0],
    ],
  ]);
  expect(past.pool[0]?.estimated).toEqual([false, false, false, false]);
});

test("a week to 100% costs the windows that ran out's average, each counted once; an estimate caps at 100", () => {
  const cost = new Float64Array((3 * W) / H);
  cost.set([2, 2], 0); // a ran out at 2 h on $4
  cost.set([8], W / H); // a ran out again at W + 1 h on $8
  const hour = { from: 0, byAccount: new Map([["a", cost]]) };
  expect(perFullWeek([win("a", 0, 2 * H), win("a", W, W + H)], hour)).toBe(6);
  expect(perFullWeek([win("a", 0, null)], hour)).toBeNull();
  // $9 on a $6 week is 150%: drawn at 100, the band's ends capped too.
  const spend = new Float64Array([3, 6]);
  const guess = estimate(spend, 0, 0, 2 * H, 6);
  expect(guess.points).toEqual([
    [0, 0],
    [H, 50],
    [2 * H, 100],
  ]);
  expect(guess.band[1]).toEqual([H, 35, 65]);
  expect(guess.band[2]).toEqual([2 * H, 100, 100]);
  // No cost at all: 0% used, and a band of nothing.
  expect(estimate(undefined, 0, 0, H, 6).points).toEqual([
    [0, 0],
    [H, 0],
  ]);
});

test("a day before the readings burns what its curves rose; one with a gap is partial", () => {
  const D = 24 * H;
  const today = 10 * D;
  const curve = (
    email: string,
    anchor: PastCurve["anchor"],
    points: [number, number][],
  ): PastCurve => ({
    email,
    start: (points[0] as [number, number])[0],
    end: (points.at(-1) as [number, number])[0],
    anchor,
    points,
  });
  const curves = [
    // a: a window that hit 100% a day ago, held there to its reset; then one to its first reading.
    curve("a", "hit", [
      [today - 3 * D, 0],
      [today - D, 100],
      [today - D / 2, 100],
    ]),
    curve("a", "reading", [
      [today - D / 2, 0],
      [today + 3 * H, 30],
    ]),
    // b: nothing before noon two days back, a window that never hit.
    curve("b", "reading", [
      [today - 1.5 * D, 0],
      [today - D, 20],
      [today, 40],
      [today + 3 * H, 46],
    ]),
  ];
  const readFrom = new Map([
    ["a", today + 3 * H],
    ["b", today + 3 * H],
  ]);
  const days = withPast([{ start: today, burn: 4 }], curves, ["a", "b"], readFrom, today + 5 * H);
  expect(days.map((d) => d.start)).toEqual([today - 3 * D, today - 2 * D, today - D, today]);
  expect(days.map((d) => d.missing)).toEqual([["b"], ["b"], [], []]);
  const round = (v: number) => Math.round(v * 1e9) / 1e9;
  // The reset adds a's new window from 0 (24 by midnight), never the fall from 100.
  expect(days.map((d) => round(d.reconstructed))).toEqual([50, 70, 44, 12]);
  // Today: 3 h of it reconstructed, then what the readings measured.
  expect(days.map((d) => round(d.burn))).toEqual([50, 70, 44, 16]);
  // An estimate for b's gap changes nothing: its ±30% stays out of the sizing, the days stay partial.
  const guessed = [
    ...curves,
    curve("b", "estimate", [
      [today - 3 * D, 0],
      [today - 1.5 * D, 30],
    ]),
  ];
  expect(
    withPast([{ start: today, burn: 4 }], guessed, ["a", "b"], readFrom, today + 5 * H),
  ).toEqual(days);
  // A next window read to start half a second after the reset (huboten, 25 Sep) leaves no gap.
  const jitter = [
    curve("c", "hit", [
      [today - 2 * D, 0],
      [today - D, 100],
    ]),
    curve("c", "reading", [
      [today - D + 500, 0],
      [today + 3 * H, 10],
    ]),
  ];
  const cRead = new Map([["c", today + 3 * H]]);
  const c = withPast([{ start: today, burn: 0 }], jitter, ["c"], cRead, today + 5 * H);
  expect(c.map((d) => d.missing)).toEqual([[], [], []]);
  // No curves: the measured days' burn as it is, the hours before a's reading a gap; no readings: no days.
  const two = [
    { start: today - D, burn: 5 },
    { start: today, burn: 1 },
  ];
  expect(withPast(two, [], ["a"], readFrom, today + 5 * H)).toEqual([
    { start: today - D, burn: 5, reconstructed: 0, missing: ["a"] },
    { start: today, burn: 1, reconstructed: 0, missing: ["a"] },
  ]);
  expect(withPast([], curves, ["a"], readFrom, today)).toEqual([]);
});
