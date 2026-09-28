/**
 * The weekly % before the readings, reconstructed. No % was kept from then,
 * but a window that hit its limit has two known ends — 0% at its reset and
 * 100% at the minute Claude Code first refused a call — and the transcripts
 * say how its cost was spread between them. Each window is drawn from its
 * own ends, shaped by its own cumulative cost: no dollar figure is carried
 * from one window to another, because none holds (the cost to 100% ranged
 * $1,371 to $3,890 between the 8 windows of 15–27 Sep 2026).
 *
 * A window with no hit has one end only. The one the account's first reading
 * is in takes that reading as its other end; any other is estimated: its
 * cumulative weighted cost over what a week to 100% cost on average in the
 * windows that ran out, capped at 100, with a ±`ESTIMATE_BAND` band.
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

/**
 * An estimated window's % is off by this fraction either way: the
 * leave-one-out error of a single cost-to-100% over the 8 windows of 15–27
 * Sep 2026 was 29% RMS.
 */
export const ESTIMATE_BAND = 0.3;

/** A % used at `t` with its low and high ends: [t, low, high]. */
export type Band = [number, number, number];

/** One account's reconstructed % over one weekly window. */
export type PastCurve = {
  email: string;
  start: number;
  end: number;
  /** What its far end is: the hit's 100%, the first reading's %, or none (estimated from the cost). */
  anchor: "hit" | "reading" | "estimate";
  points: Point[];
  /** An estimate's ±`ESTIMATE_BAND`, point for point. */
  band?: Band[];
};

/** A stretch of the pool's past: % left, its low and high ends, and whether any account's share is estimated. */
export type PoolRun = { points: Point[]; range: [number, number][]; estimated: boolean[] };

export type PastLines = {
  curves: PastCurve[];
  /** The average weighted cost of a week to 100% over the windows that ran out; null with none. */
  per100: number | null;
  band: number;
  /** What the pool had left, only where every account has a curve: one run per stretch. */
  pool: PoolRun[];
  /**
   * Each account's % and the pool's at each hour from `from`, null where no
   * curve reaches; `range` the % used's band where it is estimated, and
   * `poolRange` the pool's % left where any share of it is.
   */
  hourly: {
    from: number;
    step: number;
    byAccount: (number | null)[][];
    range: ([number, number] | null)[][];
    pool: (number | null)[];
    poolRange: ([number, number] | null)[];
  };
};

/**
 * The weighted cost spent from `start` to `end`, running: at `start`, each
 * hour boundary between and `end`, an hour's cost taken as spread evenly over it.
 */
function spending(
  cost: Float64Array,
  from: number,
  start: number,
  end: number,
): { times: number[]; spent: number[] } {
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
  return { times, spent };
}

/**
 * The % from 0 at `start` to `endValue` at `end`, rising with the cost spent
 * so far. null when nothing was spent.
 */
export function reconstruct(
  cost: Float64Array,
  from: number,
  start: number,
  end: number,
  endValue: number,
): Point[] | null {
  const { times, spent } = spending(cost, from, start, end);
  const total = spent.at(-1) as number;
  if (!(total > 0)) return null;
  return times.map((t, k) => [t, (endValue * (spent[k] as number)) / total]);
}

/**
 * The average weighted cost of a week to 100%: each window that ran out
 * counts once, its cost from its reset to its hit; null with none.
 */
export function perFullWeek(windows: readonly LimitWindow[], cost: HourlyCost): number | null {
  const costs = windows.flatMap((w) => {
    const values = cost.byAccount.get(w.email);
    if (w.hitAt === null || values === undefined) return [];
    const total = spending(values, cost.from, w.start, w.hitAt).spent.at(-1) as number;
    return total > 0 ? [total] : [];
  });
  return costs.length === 0 ? null : costs.reduce((s, c) => s + c, 0) / costs.length;
}

/** A window's % from its cost alone, `per100` to 100%, capped there, with its band. */
export function estimate(
  cost: Float64Array | undefined,
  from: number,
  start: number,
  end: number,
  per100: number,
): { points: Point[]; band: Band[] } {
  const { times, spent } = spending(cost ?? new Float64Array(0), from, start, end);
  const raw = spent.map((s) => (100 * s) / per100);
  return {
    points: times.map((t, k) => [t, Math.min(100, raw[k] as number)]),
    band: times.map((t, k) => {
      const v = raw[k] as number;
      return [t, Math.min(100, v * (1 - ESTIMATE_BAND)), Math.min(100, v * (1 + ESTIMATE_BAND))];
    }),
  };
}

/** A window that never ran out and holds no reading, estimated up to the readings or now. */
function estimatedOf(
  w: LimitWindow,
  cost: HourlyCost,
  first: Point | undefined,
  per100: number | null,
  now: number,
): PastCurve | null {
  const end = Math.min(w.end, first?.[0] ?? w.end, now);
  if (per100 === null || end <= w.start) return null;
  const guess = estimate(cost.byAccount.get(w.email), cost.from, w.start, end, per100);
  return { email: w.email, start: w.start, end: w.end, anchor: "estimate", ...guess };
}

/**
 * One window's curve: to its hit and at 100% after it, to the first reading
 * in it, or before the readings estimated from its cost (`per100`).
 */
function curveOf(
  w: LimitWindow,
  cost: HourlyCost,
  first: Point | undefined,
  per100: number | null,
  now: number,
): PastCurve | null {
  const values = cost.byAccount.get(w.email);
  const read = first !== undefined && first[0] >= w.start && first[0] < w.end ? first : null;
  const base = { email: w.email, start: w.start, end: w.end };
  if (w.hitAt === null && read === null) return estimatedOf(w, cost, first, per100, now);
  if (values === undefined) return null;
  if (read !== null && (w.hitAt === null || read[0] < w.hitAt)) {
    const points = reconstruct(values, cost.from, w.start, read[0], read[1]);
    return points === null ? null : { ...base, anchor: "reading", points };
  }
  const hitAt = w.hitAt as number;
  const points = reconstruct(values, cost.from, w.start, hitAt, 100);
  if (points === null) return null;
  // Refused from the hit on: 100% until the reset, or until the readings take over.
  const held = Math.min(w.end, read?.[0] ?? w.end, now);
  if (held > hitAt) points.push([held, 100]);
  return { ...base, anchor: "hit", points };
}

/** The curve over `t`; at a reset, `before` takes the window that ends there. */
function curveOn(curves: readonly PastCurve[], t: number, before: boolean): PastCurve | undefined {
  const inside = (c: PastCurve) => {
    const a = (c.points[0] as Point)[0];
    const b = (c.points.at(-1) as Point)[0];
    return before ? a < t && t <= b : a <= t && t < b;
  };
  const edge = (c: PastCurve) =>
    (c.points[0] as Point)[0] <= t && t <= (c.points.at(-1) as Point)[0];
  return curves.find(inside) ?? curves.find(edge);
}

/** An account's % at `t` from its curves, and its band there when estimated. */
function shareOn(
  curves: readonly PastCurve[],
  t: number,
  before: boolean,
): { value: number; range: [number, number] | null } | null {
  const curve = curveOn(curves, t, before);
  if (curve === undefined) return null;
  const band = curve.band;
  const range: [number, number] | null =
    band === undefined
      ? null
      : [
          along(
            band.map(([x, lo]) => [x, lo]),
            t,
          ),
          along(
            band.map(([x, , hi]) => [x, hi]),
            t,
          ),
        ];
  return { value: along(curve.points, t), range };
}

function valueOn(curves: readonly PastCurve[], t: number, before: boolean): number | null {
  return shareOn(curves, t, before)?.value ?? null;
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

/**
 * Whether `curves` cover [a, b] with no gap. One window's reset and the
 * next one's start are read from different places and can be seconds apart
 * (huboten's 25 Sep 00:00): a gap under a minute is none.
 */
function coverOver(curves: readonly PastCurve[], a: number, b: number): boolean {
  let reached = a;
  for (const c of [...curves].sort((x, y) => startOf(x) - startOf(y))) {
    if (startOf(c) > reached + 60_000) break;
    reached = Math.max(reached, endOf(c));
  }
  return reached >= b;
}

/** The pool at one moment: % left, its low and high ends, and whether any share is estimated. */
type PoolValue = { left: number; low: number; high: number; estimated: boolean };

/** 100 − each account's %, summed, its band from the estimated shares; null when any account has none there. */
function poolAt(byAccount: readonly PastCurve[][], t: number, before: boolean): PoolValue | null {
  const out: PoolValue = { left: 0, low: 0, high: 0, estimated: false };
  for (const curves of byAccount) {
    const share = shareOn(curves, t, before);
    if (share === null) return null;
    const [lo, hi] = share.range ?? [share.value, share.value];
    out.left += 100 - share.value;
    out.low += 100 - hi;
    out.high += 100 - lo;
    out.estimated ||= share.range !== null;
  }
  return out;
}

/** The pool's values at `t`: a vertical step where a reset changes it, the arriving side only on a run's start. */
function poolStep(byAccount: readonly PastCurve[][], t: number, open: boolean): PoolValue[] {
  const before = poolAt(byAccount, t, true);
  const after = poolAt(byAccount, t, false);
  if (after === null) return before !== null && open ? [before] : [];
  return before !== null && before.left !== after.left && open ? [before, after] : [after];
}

/** The pool's line wherever every account has a curve, broken where any has none. */
export function poolPast(byAccount: readonly PastCurve[][]): PoolRun[] {
  if (byAccount.length === 0) return [];
  const times = [...new Set(byAccount.flat().flatMap((c) => c.points.map(([t]) => t)))].sort(
    (a, b) => a - b,
  );
  const runs: PoolRun[] = [];
  let run: PoolRun = { points: [], range: [], estimated: [] };
  let last: number | null = null;
  for (const t of times) {
    if (last !== null && poolAt(byAccount, (last + t) / 2, false) === null) {
      runs.push(run);
      run = { points: [], range: [], estimated: [] };
    }
    for (const p of poolStep(byAccount, t, run.points.length > 0)) {
      run.points.push([t, p.left]);
      run.range.push([p.low, p.high]);
      run.estimated.push(p.estimated);
    }
    last = t;
  }
  runs.push(run);
  return runs.filter((r) => r.points.length > 1);
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
  const per100 = perFullWeek(windows, cost);
  const curves = windows
    .map((w) => curveOf(w, cost, firsts.get(w.email), per100, now))
    .filter((c): c is PastCurve => c !== null);
  const byAccount = emails.map((email) => curves.filter((c) => c.email === email));
  const hours: number[] = [];
  for (let t = from; t < until; t += HOUR) hours.push(t);
  const pools = hours.map((t) => poolAt(byAccount, t, false));
  return {
    curves,
    per100,
    band: ESTIMATE_BAND,
    pool: poolPast(byAccount),
    hourly: {
      from,
      step: HOUR,
      byAccount: byAccount.map((own) => hours.map((t) => valueOn(own, t, false))),
      range: byAccount.map((own) => hours.map((t) => shareOn(own, t, false)?.range ?? null)),
      pool: pools.map((p) => p?.left ?? null),
      poolRange: pools.map((p) => (p?.estimated ? [p.low, p.high] : null)),
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
   * Accounts with no reconstructed curve over part of the day before their
   * first reading (a window that never hit its limit: estimated on the
   * burn-down at most): `burn` leaves their share of that stretch out, so the
   * day is partial.
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
  // An estimate's ±30% stays off the sizing: its days are partial.
  const known = curves.filter((c) => c.anchor !== "estimate");
  const earliest = Math.min((measured[0] as DayBurn).start, ...known.map(startOf));
  const back = Math.min(DAILY_DAYS - 1, Math.ceil((today - earliest) / DAY));
  const burns = new Map(measured.map((d) => [d.start, d.burn]));
  const days: PoolDay[] = [];
  for (let start = today - back * DAY; start <= today; start += DAY) {
    const day: PoolDay = { start, burn: burns.get(start) ?? 0, reconstructed: 0, missing: [] };
    for (const email of emails) {
      const b = Math.min(start + DAY, now, readFrom.get(email) ?? now);
      if (b <= start) continue;
      const own = known.filter((c) => c.email === email);
      day.reconstructed += riseOver(own, start, b);
      if (!coverOver(own, start, b)) day.missing.push(email);
    }
    day.burn += day.reconstructed;
    days.push(day);
  }
  return days;
}
