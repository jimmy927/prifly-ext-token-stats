/**
 * The Forecast view's numbers, from the readings `readings.ts` keeps: how
 * fast each account's limits are being spent, when each runs out against its
 * reset, how much the whole pool burns a day, and the weekly percent of each
 * account three days back and six days ahead.
 *
 * A rate is the rise over the trailing 24 hours of readings, never reaching
 * back past the start of the window the latest reading is in. Where the
 * readings span under an hour it is the latest reading's average since that
 * start, when the window is known and an hour old: every window starts at 0.
 * The weekly forecast runs every account at the average of those rates:
 * which account is used, and so which burns fast, is chance, so one
 * account's own rate says nothing about its next days.
 * Pure functions: `index.ts` hands them the readings and the time.
 */

import type { LimitHistory } from "./history";
import type { PastLines, PoolDay } from "./past";
import type { AccountFreeReset } from "./prifly-api";
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
  /** Its own percent a hour, from `rateFrom`; null when neither gives one. */
  ratePerHour: number | null;
  /** The percent a hour its outcome and forecast run at: the pool's average, else its own. */
  forecastRate: number | null;
  /**
   * readings: the rise over the last 24 h of readings in this window;
   * reset: the latest percent over the hours since the window started — for
   * an account at 100 its first reading at 100, a floor, since it got there
   * before that reading; ran out: an account at 100 whose hit the
   * transcripts give, 100% over the hours from the window's start to it.
   */
  rateFrom: "readings" | "reset" | "ran out" | null;
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

/**
 * What one free reset does for an account whose weekly limit runs dry: used
 * when it runs out (now, when it is spent), it puts the weekly limit back to
 * 0% and the account burns on at its rate until the weekly reset.
 */
export type FreeResetEffect = {
  /** When to use it: the run-out, or now for a spent account. */
  usedAt: number;
  spentNow: boolean;
  /** The account's dry hours, which the reset is for. */
  dryHours: number;
  /** Of those, the hours the reset covers: 100% at the rate lasts 100 / rate hours. */
  coveredHours: number;
  /** The weekly percent at the weekly reset, after using it. */
  atReset: number;
};

/** What the free resets do for the pool, in account-hours with no tokens. */
export type FreeResetPool = {
  /** The dry hours of the accounts that have a free reset. */
  dryHours: number;
  /** Of those, the hours their resets cover, each used as its account runs dry. */
  coveredHours: number;
  /** Every account's dry hours, the banner's number, and what is left of it after the resets. */
  poolDryHours: number;
  poolDryHoursAfter: number;
};

export type AccountForecast = {
  email: string;
  label: string;
  startsNewSessions: boolean;
  /** Its free resets ("Reset for free", claude.ai Settings → Usage); null with none. */
  freeResets: AccountFreeReset | null;
  /** What using a free reset when the account runs dry does; null without one, or without a rate. */
  freeResetEffect: FreeResetEffect | null;
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

/** What the whole pool has left, the sum of 100 − each account's percent. */
export type PoolLine = {
  /** At each weekly reading of the last 3 days, from the first time every account had one. */
  measured: Point[];
  /** From the newest reading to 6 days ahead, each account at its rate; a reset is a vertical step. */
  forecast: Point[];
};

/** Pool burn on one local day, in percent of one account's weekly limit. */
export type DayBurn = { start: number; burn: number };

export type ForecastAnswer = {
  /** Whether this prifly has `accounts()`. */
  supported: boolean;
  now: number;
  /** When the newest reading was taken. */
  newestAt: number | null;
  /** When the oldest reading kept was taken, null before the first. */
  firstAt: number | null;
  accounts: AccountForecast[];
  /** The average weekly rate of the accounts that have one, which every forecast runs at; null with none. */
  averageRate: number | null;
  /** Oldest first; the last is today, so far. Days before the readings are reconstructed. */
  daily: PoolDay[];
  /**
   * Hour by hour from the hour of the first reading, at most 3 days back, to
   * 6 days ahead: what the pool has left, the sum of 100 − percent.
   */
  grid: { from: number; step: number; pool: (number | null)[] };
  pool: PoolLine;
  /** null when no account has a free reset with a rate to judge it by. */
  freeResetPool: FreeResetPool | null;
  /** The past before the readings, from the transcripts: weekly windows and limit hits. */
  history: LimitHistory;
  /** The weekly % of `history`'s windows, reconstructed from their ends and their cost. */
  past: PastLines;
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

/**
 * The latest reading's average since its window started, when that start is
 * known and at least an hour before it.
 */
export function resetRate(last: Reading, windowMs: number): number | null {
  if (last.resetsAt === null) return null;
  const hours = (last.at - (last.resetsAt - windowMs)) / HOUR;
  return hours * HOUR < MIN_SPAN ? null : Math.min(100, last.usedPercent) / hours;
}

/**
 * The rate a spent window ran out at, so its forecast falls again after each
 * reset — its readings, all at 100, rise at 0: 100% over the hours from the
 * window's start to `hitAt`, or without a hit its first reading at 100's
 * average since the start.
 */
export function ranOutRate(
  readings: readonly Reading[],
  windowMs: number,
  hitAt: number | null,
): { rate: number | null; from: "reset" | "ran out" } {
  const last = readings.at(-1) as Reading;
  if (hitAt !== null && last.resetsAt !== null) {
    return { rate: 100 / ((hitAt - (last.resetsAt - windowMs)) / HOUR), from: "ran out" };
  }
  const start = last.resetsAt === null ? Number.NEGATIVE_INFINITY : last.resetsAt - windowMs;
  const full = readings.find((r) => r.at >= start && r.usedPercent >= 100) as Reading;
  return { rate: resetRate(full, windowMs), from: "reset" };
}

/** The rate of one window: its readings', else its average since the reset; a spent one's from how it ran out. */
function rateOf(
  readings: readonly Reading[],
  windowMs: number,
  hitAt: number | null,
): { rate: number | null; from: WindowState["rateFrom"] } {
  const last = readings.at(-1) as Reading;
  if (last.usedPercent >= 100) return ranOutRate(readings, windowMs, hitAt);
  const fromReadings = burnRate(readings, windowMs);
  if (fromReadings !== null) return { rate: fromReadings, from: "readings" };
  const rate = resetRate(last, windowMs);
  return { rate, from: rate === null ? null : "reset" };
}

/**
 * Where the latest reading and a rate leave one window, at `now`; `hitAt`
 * the minute the transcripts say it hit 100, when they do. The rate is
 * `average` when given, else the window's own.
 */
export function windowState(
  readings: readonly Reading[],
  windowMs: number,
  now: number,
  hitAt: number | null = null,
  average: number | null = null,
): WindowState | null {
  const last = readings.at(-1);
  if (last === undefined) return null;
  const { rate: own, from } = rateOf(readings, windowMs, hitAt);
  const rate = average ?? own;
  const { usedPercent: percent, resetsAt, at: readAt } = last;
  const state: WindowState = {
    percent,
    resetsAt,
    readAt,
    ratePerHour: own,
    rateFrom: own === null ? null : from,
    forecastRate: rate,
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

/**
 * The value of a line of points at `t`: at a vertical step the later one, or
 * with `before` the earlier; null outside it.
 */
export function valueAt(points: readonly Point[], t: number, before = false): number | null {
  const first = points[0];
  const last = points.at(-1);
  if (first === undefined || last === undefined || t < first[0] || t > last[0]) return null;
  let value: number | null = null;
  for (let k = 0; k < points.length - 1; k++) {
    const [x0, y0] = points[k] as Point;
    const [x1, y1] = points[k + 1] as Point;
    if (t >= x0 && t <= x1 && !(before && value !== null))
      value = x1 === x0 ? (before ? y0 : y1) : y0 + ((t - x0) / (x1 - x0)) * (y1 - y0);
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

/** One account's weekly readings as points, capped at 100. */
const weeklyPoints = (own: Record<Window, Reading[]> | undefined): Point[] =>
  (own?.["7d"] ?? []).map((r) => [r.at, Math.min(100, r.usedPercent)]);

/** What one free reset does for `weekly`, at its rate; null with no reset left or no rate. */
export function freeResetEffect(
  freeResets: AccountFreeReset | null,
  weekly: WindowState | null,
  now: number,
): FreeResetEffect | null {
  if (freeResets === null || freeResets.left <= 0) return null;
  const rate = weekly?.forecastRate ?? null;
  if (weekly === null || rate === null) return null;
  const spentNow = weekly.outcome === "spent";
  return {
    usedAt: spentNow ? now : (weekly.runsOutAt ?? now),
    spentNow,
    dryHours: weekly.dryHours,
    coveredHours: Math.min(weekly.dryHours, 100 / rate),
    atReset: Math.min(100, rate * weekly.dryHours),
  };
}

/** The resets' effect on the pool's dry hours (the sum the runway banner shows); null with none to judge. */
export function freeResetPool(lines: readonly AccountForecast[]): FreeResetPool | null {
  const effects = lines.flatMap((l) => (l.freeResetEffect === null ? [] : [l.freeResetEffect]));
  if (effects.length === 0) return null;
  const sum = (values: readonly number[]) => values.reduce((s, v) => s + v, 0);
  const coveredHours = sum(effects.map((e) => e.coveredHours));
  const poolDryHours = sum(lines.map((l) => l.weekly?.dryHours ?? 0));
  return {
    dryHours: sum(effects.map((e) => e.dryHours)),
    coveredHours,
    poolDryHours,
    poolDryHoursAfter: poolDryHours - coveredHours,
  };
}

/**
 * The average of the accounts' own weekly rates, where they have one: the
 * rate every weekly forecast runs at. null when none has a rate.
 */
export function averageRate(rates: readonly (number | null)[]): number | null {
  const known = rates.filter((r): r is number => r !== null);
  return known.length === 0 ? null : known.reduce((s, r) => s + r, 0) / known.length;
}

/**
 * One account's runway and lines at `average` (its own rate when null), and
 * the line it is held to ahead: its forecast, or level without a rate.
 */
function accountLines(
  meta: AccountMeta,
  own: Record<Window, Reading[]> | undefined,
  now: number,
  grid: number[],
  hitAt: number | null,
  average: number | null,
): { line: AccountForecast; holding: Point[] } {
  const weeklyMs = meta.windowMs["7d"];
  const sessionMs = meta.windowMs["5h"];
  const weekly =
    own && weeklyMs !== undefined ? windowState(own["7d"], weeklyMs, now, hitAt, average) : null;
  const session = own && sessionMs !== undefined ? windowState(own["5h"], sessionMs, now) : null;
  const measured = weeklyPoints(own).filter(([t]) => t >= now - MEASURED);
  let holding: Point[] = [];
  let forecast: Point[] = [];
  if (weekly !== null && weeklyMs !== undefined) {
    const ahead = (rate: number) =>
      forecastPoints(weekly.percent, weekly.readAt, rate, weekly.resetsAt, weeklyMs, now + AHEAD);
    holding = ahead(weekly.forecastRate ?? 0);
    if (weekly.forecastRate !== null) forecast = holding;
  }
  const at = (line: Point[], t: number) =>
    t <= (weekly?.readAt ?? Number.NEGATIVE_INFINITY) ? valueAt(measured, t) : valueAt(line, t);
  const line: AccountForecast = {
    email: meta.email,
    label: meta.label,
    startsNewSessions: meta.startsNewSessions,
    freeResets: meta.freeResets,
    freeResetEffect: freeResetEffect(meta.freeResets, weekly, now),
    weekly,
    session,
    measured,
    forecast,
    hourly: grid.map((t) => at(holding, t)),
  };
  return { line, holding };
}

/** What the pool has left, 100 − each value, summed. */
const left = (values: readonly number[]): number => values.reduce((sum, v) => sum + 100 - v, 0);

/**
 * The pool's measured line: at each weekly reading of the last 3 days from
 * the first moment every account with readings had one, each account read
 * off its own readings and held at its latest after it.
 */
export function poolMeasured(points: readonly Point[][], now: number): Point[] {
  const start = Math.max(now - MEASURED, ...points.map((p) => p[0]?.[0] ?? now));
  const times = [...new Set(points.flat().map(([t]) => t))]
    .filter((t) => t >= start)
    .sort((a, b) => a - b);
  const at = (p: readonly Point[], t: number) => valueAt(p, t) ?? (p.at(-1) as Point)[1];
  return times.map((t) => [t, left(points.map((p) => at(p, t)))]);
}

/**
 * The pool's forecast: from the newest reading to `until`, the sum over the
 * accounts' held lines at each of their corners, a reset drawn as a vertical step.
 */
export function poolForecast(holdings: readonly Point[][], until: number): Point[] {
  if (holdings.length === 0) return [];
  const from = Math.max(...holdings.map((h) => (h[0] as Point)[0]));
  const times = [...new Set(holdings.flat().map(([t]) => t))]
    .filter((t) => t > from && t <= until)
    .sort((a, b) => a - b);
  const sum = (t: number, before: boolean) =>
    left(holdings.map((h) => valueAt(h, t, before) as number));
  const out: Point[] = [[from, sum(from, false)]];
  for (const t of times) {
    const before = sum(t, true);
    const after = sum(t, false);
    if (before !== after) out.push([t, before]);
    out.push([t, after]);
  }
  return out;
}

/**
 * Everything the Forecast view shows, for the accounts connected now;
 * `ranOut` the minute each account hit 100 in its current weekly window,
 * where the transcripts give it.
 */
export function forecast(
  readings: readonly Reading[],
  accounts: readonly AccountMeta[],
  now: number,
  ranOut: ReadonlyMap<string, number>,
): Omit<ForecastAnswer, "supported" | "newestAt" | "history" | "past" | "daily"> {
  // The chart starts at the first reading when that is less than 3 days back: no empty days drawn as measured.
  const from = Math.floor(Math.max(now - MEASURED, readings[0]?.at ?? now) / HOUR) * HOUR;
  const grid: number[] = [];
  for (let t = from; t <= now + AHEAD; t += HOUR) grid.push(t);
  const byEmail = byAccount(readings);
  const hit = (meta: AccountMeta) => ranOut.get(meta.email) ?? null;
  const ownRate = (meta: AccountMeta) => {
    const weeklyMs = meta.windowMs["7d"];
    const own = byEmail.get(meta.email)?.["7d"];
    if (own === undefined || weeklyMs === undefined) return null;
    return windowState(own, weeklyMs, now, hit(meta))?.ratePerHour ?? null;
  };
  const average = averageRate(accounts.map(ownRate));
  const worked = accounts.map((meta) =>
    accountLines(meta, byEmail.get(meta.email), now, grid, hit(meta), average),
  );
  const lines = worked.map((w) => w.line);
  const read = accounts
    .map((meta) => weeklyPoints(byEmail.get(meta.email)))
    .filter((p) => p.length > 0);
  const holdings = worked.map((w) => w.holding).filter((h) => h.length > 0);
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
    averageRate: average,
    grid: { from, step: HOUR, pool },
    pool: { measured: poolMeasured(read, now), forecast: poolForecast(holdings, now + AHEAD) },
    freeResetPool: freeResetPool(lines),
    firstAt: readings[0]?.at ?? null,
  };
}
