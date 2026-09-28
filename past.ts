/**
 * The weekly % before the readings, reconstructed. No % was kept from then,
 * but a window that hit its limit has two known ends — 0% at its reset and
 * 100% at the minute Claude Code first refused a call — and the transcripts
 * say how its cost was spread between them. Each window is drawn from its
 * own ends, shaped by its own cumulative cost: no dollar figure is carried
 * from one window to another, because none holds (the cost to 100% ranged
 * $1,371 to $3,890 between the 8 windows of 15–27 Sep 2026).
 *
 * A window with no hit has one end only and is not drawn, except the one the
 * account's first reading is in: that reading is its other end.
 */

import type { HourlyCost } from "./answer";
import { DAILY_DAYS, type DayBurn, type Point } from "./forecast";
import type { LimitWindow } from "./history";
import { familyOf } from "./prices";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/**
 * How much faster a dollar of a model fills the weekly limit than a dollar of
 * Opus 5, at API list prices. Fit on the 8 windows of 15–27 Sep 2026 (every
 * window at 100% at its hit): 100% took $3,610 of Opus 5, $1,620 of Opus 5.5
 * (2.2×) and $1,912 of Fable (1.9×), rounded to 2 for both.
 */
export function limitWeight(model: string): number {
  const family = familyOf(model);
  return family === "claude-opus-5-5" || family.startsWith("claude-fable-") ? 2 : 1;
}

/** One account's reconstructed % over one weekly window. */
export type PastCurve = {
  email: string;
  start: number;
  end: number;
  /** What its far end is: the hit's 100%, or the first reading's %. */
  anchor: "hit" | "reading";
  points: Point[];
};

export type PastLines = {
  curves: PastCurve[];
  /** What the pool had left, only where every account has a curve: one run per stretch. */
  pool: Point[][];
  /** Each account's % and the pool's at each hour from `from`, null where no curve reaches. */
  hourly: { from: number; step: number; byAccount: (number | null)[][]; pool: (number | null)[] };
};

/**
 * The % from 0 at `start` to `endValue` at `end`, rising with the cost spent
 * so far: a point at `start`, each hour boundary between and `end`, an hour's
 * cost taken as spread evenly over it. null when nothing was spent.
 */
export function reconstruct(
  cost: Float64Array,
  from: number,
  start: number,
  end: number,
  endValue: number,
): Point[] | null {
  const times = [start];
  for (let t = Math.floor(start / HOUR) * HOUR + HOUR; t < end; t += HOUR) times.push(t);
  times.push(end);
  const spent = [0];
  for (let k = 1; k < times.length; k++) {
    const t0 = times[k - 1] as number;
    const t1 = times[k] as number;
    const hour = cost[Math.floor((t0 - from) / HOUR)] ?? 0;
    spent.push((spent[k - 1] as number) + (hour * (t1 - t0)) / HOUR);
  }
  const total = spent.at(-1) as number;
  if (!(total > 0)) return null;
  return times.map((t, k) => [t, (endValue * (spent[k] as number)) / total]);
}

/** One window's curve: to its hit and at 100% after it, or to the first reading in it. */
function curveOf(
  w: LimitWindow,
  cost: HourlyCost,
  first: Point | undefined,
  now: number,
): PastCurve | null {
  const values = cost.byAccount.get(w.email);
  if (values === undefined) return null;
  const read = first !== undefined && first[0] >= w.start && first[0] < w.end ? first : null;
  const base = { email: w.email, start: w.start, end: w.end };
  if (read !== null && (w.hitAt === null || read[0] < w.hitAt)) {
    const points = reconstruct(values, cost.from, w.start, read[0], read[1]);
    return points === null ? null : { ...base, anchor: "reading", points };
  }
  if (w.hitAt === null) return null;
  const points = reconstruct(values, cost.from, w.start, w.hitAt, 100);
  if (points === null) return null;
  // Refused from the hit on: 100% until the reset, or until the readings take over.
  const held = Math.min(w.end, read?.[0] ?? w.end, now);
  if (held > w.hitAt) points.push([held, 100]);
  return { ...base, anchor: "hit", points };
}

/** An account's % at `t` from its curves; at a reset, `before` takes the window that ends there. */
function valueOn(curves: readonly PastCurve[], t: number, before: boolean): number | null {
  const inside = (c: PastCurve) => {
    const a = (c.points[0] as Point)[0];
    const b = (c.points.at(-1) as Point)[0];
    return before ? a < t && t <= b : a <= t && t < b;
  };
  const edge = (c: PastCurve) =>
    (c.points[0] as Point)[0] <= t && t <= (c.points.at(-1) as Point)[0];
  const curve = curves.find(inside) ?? curves.find(edge);
  return curve === undefined ? null : along(curve.points, t);
}

/** A curve's % at `t`, between its points; its last % past its end. */
function along(p: readonly Point[], t: number): number {
  for (let k = 0; k < p.length - 1; k++) {
    const [x0, y0] = p[k] as Point;
    const [x1, y1] = p[k + 1] as Point;
    if (t >= x0 && t <= x1) return x1 === x0 ? y1 : y0 + ((t - x0) / (x1 - x0)) * (y1 - y0);
  }
  return (p.at(-1) as Point)[1];
}

const startOf = (c: PastCurve) => (c.points[0] as Point)[0];
const endOf = (c: PastCurve) => (c.points.at(-1) as Point)[0];

/** What `curves` rose over [a, b]: each window from its own 0, so a reset adds and never subtracts. */
function riseOver(curves: readonly PastCurve[], a: number, b: number): number {
  let sum = 0;
  for (const c of curves) {
    const lo = Math.max(a, startOf(c));
    const hi = Math.min(b, endOf(c));
    if (hi > lo) sum += along(c.points, hi) - along(c.points, lo);
  }
  return sum;
}

/** Whether `curves` cover [a, b] with no gap. */
function coverOver(curves: readonly PastCurve[], a: number, b: number): boolean {
  let reached = a;
  for (const c of [...curves].sort((x, y) => startOf(x) - startOf(y))) {
    if (startOf(c) > reached) break;
    reached = Math.max(reached, endOf(c));
  }
  return reached >= b;
}

/** 100 − each account's %, summed; null when any account has none there. */
function poolAt(byAccount: readonly PastCurve[][], t: number, before: boolean): number | null {
  let sum = 0;
  for (const curves of byAccount) {
    const v = valueOn(curves, t, before);
    if (v === null) return null;
    sum += 100 - v;
  }
  return sum;
}

/** The pool's points at `t`: a vertical step where a reset changes it, the arriving side only on a run's start. */
function poolStep(byAccount: readonly PastCurve[][], t: number, open: boolean): Point[] {
  const before = poolAt(byAccount, t, true);
  const after = poolAt(byAccount, t, false);
  if (after === null) return before !== null && open ? [[t, before]] : [];
  return before !== null && before !== after && open
    ? [
        [t, before],
        [t, after],
      ]
    : [[t, after]];
}

/** The pool's line wherever every account has a curve, broken where any has none. */
export function poolPast(byAccount: readonly PastCurve[][]): Point[][] {
  if (byAccount.length === 0) return [];
  const times = [...new Set(byAccount.flat().flatMap((c) => c.points.map(([t]) => t)))].sort(
    (a, b) => a - b,
  );
  const runs: Point[][] = [[]];
  let last: number | null = null;
  for (const t of times) {
    if (last !== null && poolAt(byAccount, (last + t) / 2, false) === null) runs.push([]);
    const run = runs.at(-1) as Point[];
    run.push(...poolStep(byAccount, t, run.length > 0));
    last = t;
  }
  return runs.filter((run) => run.length > 1);
}

/**
 * The reconstructed past of `emails`' accounts, in that order: a curve per
 * window it can be drawn for, the pool where every account has one, and
 * both hour by hour from `from` until `until` for the hover.
 */
export function reconstructPast(
  windows: readonly LimitWindow[],
  cost: HourlyCost,
  firsts: ReadonlyMap<string, Point>,
  emails: readonly string[],
  from: number,
  until: number,
  now: number,
): PastLines {
  const curves = windows
    .map((w) => curveOf(w, cost, firsts.get(w.email), now))
    .filter((c): c is PastCurve => c !== null);
  const byAccount = emails.map((email) => curves.filter((c) => c.email === email));
  const hours: number[] = [];
  for (let t = from; t < until; t += HOUR) hours.push(t);
  return {
    curves,
    pool: poolPast(byAccount),
    hourly: {
      from,
      step: HOUR,
      byAccount: byAccount.map((own) => hours.map((t) => valueOn(own, t, false))),
      pool: hours.map((t) => poolAt(byAccount, t, false)),
    },
  };
}

/**
 * One local day of pool burn, in % of one account's weekly limit: measured
 * from the readings, and before each account's first reading reconstructed
 * from its curves — the same curves the burn-down draws dotted.
 */
export type PoolDay = DayBurn & {
  /** The part of `burn` reconstructed from the transcripts. */
  reconstructed: number;
  /**
   * Accounts with no curve over part of the day before their first reading
   * (a window that never hit its limit): `burn` leaves their share of that
   * stretch out, so the day is partial.
   */
  missing: string[];
};

/**
 * The measured days, oldest first and today last, with the days before the
 * readings added back to the first a curve reaches (at most 14 in all), and
 * each day's stretch before an account's first reading (`readFrom`) filled
 * from that account's curves.
 */
export function withPast(
  measured: readonly DayBurn[],
  curves: readonly PastCurve[],
  emails: readonly string[],
  readFrom: ReadonlyMap<string, number>,
  now: number,
): PoolDay[] {
  const today = measured.at(-1)?.start;
  if (today === undefined) return [];
  const earliest = Math.min((measured[0] as DayBurn).start, ...curves.map(startOf));
  const back = Math.min(DAILY_DAYS - 1, Math.ceil((today - earliest) / DAY));
  const burns = new Map(measured.map((d) => [d.start, d.burn]));
  const days: PoolDay[] = [];
  for (let start = today - back * DAY; start <= today; start += DAY) {
    const day: PoolDay = { start, burn: burns.get(start) ?? 0, reconstructed: 0, missing: [] };
    for (const email of emails) {
      const b = Math.min(start + DAY, now, readFrom.get(email) ?? now);
      if (b <= start) continue;
      const own = curves.filter((c) => c.email === email);
      day.reconstructed += riseOver(own, start, b);
      if (!coverOver(own, start, b)) day.missing.push(email);
    }
    day.burn += day.reconstructed;
    days.push(day);
  }
  return days;
}
