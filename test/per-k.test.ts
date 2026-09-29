import { expect, test } from "bun:test";
import { MIN_LINES, perKSeries, trailingPerK, windowOf } from "../per-k";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

test("a point looks back a day, or over its own bucket when that is longer", () => {
  expect(windowOf(HOUR)).toBe(24);
  expect(windowOf(6 * HOUR)).toBe(4);
  expect(windowOf(DAY)).toBe(1);
  expect(windowOf(7 * DAY)).toBe(1);
});

test("spend and lines sum over the trailing window, and drop out of it after", () => {
  // Six-hour buckets: a window of four.
  const cost = [10, 10, 10, 10, 10, 0];
  const lines = [0, 0, 500, 0, 0, 0];
  const got = trailingPerK(cost, lines, 6 * HOUR);
  expect(got.slice(0, 2)).toEqual([null, null]);
  expect(got[2]).toBeCloseTo((30 / 500) * 1000, 9);
  expect(got[4]).toBeCloseTo((40 / 500) * 1000, 9);
  // Bucket 5's window is buckets 2–5, still holding the 500 lines.
  expect(got[5]).toBeCloseTo((30 / 500) * 1000, 9);
});

test("a window with too few lines is a gap, not a spike", () => {
  const got = trailingPerK([50, 50], [MIN_LINES - 1, 0], DAY);
  expect(got).toEqual([null, null]);
});

test("the total line sums every repository; per repository only those with lines, by spend", () => {
  const entries = [
    { name: "a", slot: 0, tone: null, cost: [10, 10], lines: [1000, 0] },
    { name: "b", slot: 1, tone: null, cost: [40, 0], lines: [0, 2000] },
    { name: "c", slot: 2, tone: null, cost: [99, 99], lines: [0, 0] },
  ];
  const { perK, perKByRepo } = perKSeries(entries, DAY, 2, 8, "All repositories");
  expect(perK.label).toBe("All repositories");
  expect(perK.values[0]).toBeCloseTo((149 / 1000) * 1000, 9);
  expect(perK.total).toBeCloseTo((258 / 3000) * 1000, 9);
  expect(perKByRepo.map((s) => s.key)).toEqual(["b", "a"]);
  expect(perKByRepo[0]?.values).toEqual([null, 0]);
  expect(perKByRepo[1]?.total).toBeCloseTo(20, 9);
});
