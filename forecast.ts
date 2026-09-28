/**
 * The Forecast view's numbers, from the readings `readings.ts` keeps: how
 * fast each account's limits are being spent, when each runs out against its
 * reset, how much the whole pool burns a day, and the weekly percent of each
 * account three days back and six days ahead.
 *
 * Every rate is the rise over the trailing 24 hours of readings, never
 * reaching back past the start of the window the latest reading is in.
 * Pure functions: `index.ts` hands them the readings and the time.
 */

import { floorTo } from "./query";
import type { AccountMeta, Reading, Window } from "./readings";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** How far back a rate looks. */
export const RATE_SPAN = 24 * HOUR;
/** Readings spanning less than this give no rate. */
export const MIN_SPAN = HOUR;
/** The burn-down chart: measured this far back, forecast this far ahead. */
export const MEASURED = 3 * DAY;
export const AHEAD = 6 * DAY;
/** Days of pool burn the answer carries. */
export const DAILY_DAYS = 14;

/** [epoch ms, percent]. */
export type Point = [number, number];

/** One limit of one account, as its latest reading and the rate before it leave it. */
export type WindowState = {
  percent: number;
  resetsAt: number | null;
  readAt: number;
  /** Percent a hour over the last 24 h of this window; null when the readings span under an hour. */
  ratePerHour: number | null;
  /**
   * spent: at 100 now; dry: reaches 100 before the reset; lasts: does not;
   * unknown: no rate, or no reset to measure against.
   */
  outcome: "spent" | "dry" | "lasts" | "unknown";
  /** When it reaches 100, for "dry". */
  runsOutAt: number | null;
  /** The percent at the reset, for "lasts". */
  atReset: number | null;
  /** How much of the window has passed at `now`, 0–100; null without a reset. */
  elapsed: number | null;
  /** Hours with nothing left before the reset: "spent" and "dry" only, else 0. */
  dryHours: number;
};

export type AccountForecast = {
  email: string;
  label: string;
  startsNewSessions: boolean;
  /** null before the first reading. */
  weekly: WindowState | null;
  session: WindowState | null;
  /** The weekly percent read over the last 3 days. */
  measured: Point[];
  /** The weekly percent from the latest reading to 6 days ahead, at its rate; [] without a rate. */
  forecast: Point[];
  /**
   * The weekly percent at each hour of `grid`: measured, then forecast — an
   * account with no rate held where it is until its reset. null before its
   * first reading.
   */
  hourly: (number | null)[];
};

/** Pool burn on one local day, in percent of one account's weekly limit. */
export type DayBurn = { start: number; burn: number };

export type ForecastAnswer = {
  /** Whether this prifly has `accounts()`. */
  supported: boolean;
  now: number;
  /** When the newest reading was taken. */
  newestAt: number | null;
  accounts: AccountForecast[];
  /** Oldest first; the last is today, so far. */
  daily: DayBurn[];
  /** Hour by hour from 3 days back to 6 ahead: what the pool has left, the sum of 100 − percent. */
  grid: { from: number; step: number; pool: (number | null)[] };
};

/** The rise per hour over the trailing 24 h of `readings` (one account, one window, oldest first). */
export function burnRate(readings: readonly Reading[], windowMs: number): number | null {
  const last = readings.at(-1);
  if (last === undefined) return null;
  const start = last.resetsAt === null ? Number.NEGATIVE_INFINITY : last.resetsAt - windowMs;
  const from = Math.max(last.at - RATE_SPAN, start);
  const first = readings.find((r) => r.at >= from);
  if (first === undefined || last.at - first.at < MIN_SPAN) return null;
  // A percent that fell inside one window (the plan's own correction) is no negative burn.
  return Math.max(0, last.usedPercent - first.usedPercent) / ((last.at - first.at) / HOUR);
}

/** Where the latest reading and its rate leave one window, at `now`. */
export function windowState(
  readings: readonly Reading[],
  windowMs: number,
  now: number,
): WindowState | null {
  const last = readings.at(-1);
  if (last === undefined) return null;
  const rate = burnRate(readings, windowMs);
  const { usedPercent: percent, resetsAt, at: readAt } = last;
  const state: WindowState = {
    percent,
    resetsAt,
    readAt,
    ratePerHour: rate,
    outcome: "unknown",
    runsOutAt: null,
    atReset: null,
    elapsed:
      resetsAt === null
        ? null
        : Math.min(100, Math.max(0, ((now - (resetsAt - windowMs)) / windowMs) * 100)),
    dryHours: 0,
  };
  if (percent >= 100) {
    return {
      ...state,
      outcome: "spent",
      dryHours: resetsAt === null ? 0 : Math.max(0, resetsAt - readAt) / HOUR,
    };
  }
  if (rate === null || resetsAt === null) return state;
  const runsOutAt = rate > 0 ? readAt + ((100 - percent) / rate) * HOUR : Number.POSITIVE_INFINITY;
  if (runsOutAt < resetsAt) {
    return { ...state, outcome: "dry", runsOutAt, dryHours: (resetsAt - runsOutAt) / HOUR };
  }
  return { ...state, outcome: "lasts", atReset: percent + (rate * (resetsAt - readAt)) / HOUR };
}

/**
 * The weekly percent from `from` to `until` at `rate` per hour: capped at 100,
 * back to 0 at each reset, which comes round every `windowMs`.
 */
export function forecastPoints(
  percent: number,
  from: number,
  rate: number,
  resetsAt: number | null,
  windowMs: number,
  until: number,
): Point[] {
  let value = Math.min(percent, 100);
  const out: Point[] = [[from, value]];
  let t = from;
  let reset = resetsAt ?? Number.POSITIVE_INFINITY;
  while (t < until) {
    const end = Math.min(reset, until);
    const full = rate > 0 ? t + ((100 - value) / rate) * HOUR : Number.POSITIVE_INFINITY;
    if (full < end) out.push([full, 100], [end, 100]);
    else out.push([end, value + (rate * (end - t)) / HOUR]);
    t = end;
    value = out.at(-1)?.[1] ?? value;
    if (end === reset) {
      out.push([reset, 0]);
      value = 0;
      reset += windowMs;
    }
  }
  return out;
}

/** The value of a line of points at `t`: at a vertical step, the later one; null outside it. */
export function valueAt(points: readonly Point[], t: number): number | null {
  const first = points[0];
  const last = points.at(-1);
  if (first === undefined || last === undefined || t < first[0] || t > last[0]) return null;
  let value: number | null = null;
  for (let k = 0; k < points.length - 1; k++) {
    const [x0, y0] = points[k] as Point;
    const [x1, y1] = points[k + 1] as Point;
    if (t >= x0 && t <= x1) value = x1 === x0 ? y1 : y0 + ((t - x0) / (x1 - x0)) * (y1 - y0);
  }
  return value ?? last[1];
}

/**
 * Pool burn per local day, over the last 14 days since the first on record:
 * the sum over accounts of each weekly reading's rise over the one before.
 * A reading whose reset is more than an hour later than the previous one's
 * starts a new window, and counts from 0.
 */
export function dailyBurn(readings: readonly Reading[], now: number, tzMs: number): DayBurn[] {
  const weekly = readings.filter((r) => r.label === "7d");
  const firstReading = weekly[0];
  if (firstReading === undefined) return [];
  const today = floorTo(now, DAY, tzMs);
  const start = Math.max(floorTo(firstReading.at, DAY, tzMs), today - (DAILY_DAYS - 1) * DAY);
  const days: DayBurn[] = [];
  for (let d = start; d <= today; d += DAY) days.push({ start: d, burn: 0 });
  const previous = new Map<string, Reading>();
  for (const r of weekly) {
    const before = previous.get(r.email);
    previous.set(r.email, r);
    if (before === undefined) continue;
    const newWindow =
      r.resetsAt !== null && before.resetsAt !== null && r.resetsAt > before.resetsAt + HOUR;
    const rise = newWindow ? r.usedPercent : Math.max(0, r.usedPercent - before.usedPercent);
    const day = days[(floorTo(r.at, DAY, tzMs) - start) / DAY];
    if (day !== undefined) day.burn += rise;
  }
  return days;
}

/** Readings by email and window, oldest first. */
function byAccount(readings: readonly Reading[]): Map<string, Record<Window, Reading[]>> {
  const out = new Map<string, Record<Window, Reading[]>>();
  for (const r of readings) {
    let held = out.get(r.email);
    if (held === undefined) {
      held = { "7d": [], "5h": [] };
      out.set(r.email, held);
    }
    held[r.label].push(r);
  }
  return out;
}

/** One account's runway and lines. */
function accountLines(
  meta: AccountMeta,
  own: Record<Window, Reading[]> | undefined,
  now: number,
  grid: number[],
): AccountForecast {
  const weeklyMs = meta.windowMs["7d"];
  const sessionMs = meta.windowMs["5h"];
  const weekly = own && weeklyMs !== undefined ? windowState(own["7d"], weeklyMs, now) : null;
  const session = own && sessionMs !== undefined ? windowState(own["5h"], sessionMs, now) : null;
  const measured: Point[] = (own?.["7d"] ?? [])
    .filter((r) => r.at >= now - MEASURED)
    .map((r) => [r.at, Math.min(100, r.usedPercent)]);
  let holding: Point[] = [];
  let forecast: Point[] = [];
  if (weekly !== null && weeklyMs !== undefined) {
    const ahead = (rate: number) =>
      forecastPoints(weekly.percent, weekly.readAt, rate, weekly.resetsAt, weeklyMs, now + AHEAD);
    holding = ahead(weekly.ratePerHour ?? 0);
    if (weekly.ratePerHour !== null) forecast = holding;
  }
  const at = (line: Point[], t: number) =>
    t <= (weekly?.readAt ?? Number.NEGATIVE_INFINITY) ? valueAt(measured, t) : valueAt(line, t);
  return {
    email: meta.email,
    label: meta.label,
    startsNewSessions: meta.startsNewSessions,
    weekly,
    session,
    measured,
    forecast,
    hourly: grid.map((t) => at(holding, t)),
  };
}

/** Everything the Forecast view shows, for the accounts connected now. */
export function forecast(
  readings: readonly Reading[],
  accounts: readonly AccountMeta[],
  now: number,
  tzMs: number,
): Omit<ForecastAnswer, "supported" | "newestAt"> {
  const from = Math.floor((now - MEASURED) / HOUR) * HOUR;
  const grid: number[] = [];
  for (let t = from; t <= now + AHEAD; t += HOUR) grid.push(t);
  const byEmail = byAccount(readings);
  const lines = accounts.map((meta) => accountLines(meta, byEmail.get(meta.email), now, grid));
  const pool = grid.map((_, k) => {
    const left = lines
      .map((l) => l.hourly[k])
      .filter((v): v is number => v !== null && v !== undefined)
      .map((v) => 100 - v);
    return left.length === 0 ? null : left.reduce((sum, v) => sum + v, 0);
  });
  return {
    now,
    accounts: lines,
    daily: dailyBurn(readings, now, tzMs),
    grid: { from, step: HOUR, pool },
  };
}
