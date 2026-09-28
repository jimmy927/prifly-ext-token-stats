import { expect, test } from "bun:test";
import {
  AHEAD,
  burnRate,
  dailyBurn,
  forecast,
  forecastPoints,
  poolForecast,
  valueAt,
  windowState,
} from "../forecast";
import type { AccountMeta, Reading } from "../readings";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
/** Sun 27 Sep 2026 12:00 UTC, 13:00 CET. */
const NOW = Date.UTC(2026, 8, 27, 12);
const CET = HOUR;

/** A weekly reading `h` hours from now. */
const wk = (
  h: number,
  usedPercent: number,
  resetsAt: number | null,
  email = "a@x.com",
): Reading => ({
  at: NOW + h * HOUR,
  email,
  label: "7d",
  usedPercent,
  resetsAt,
});

test("the rate is the rise over the last 24 h of readings", () => {
  const reset = NOW + 100 * HOUR;
  // 48 h ago is outside the 24 h; from -24 h (40%) to now (64%): 1 %/h.
  const readings = [wk(-48, 10, reset), wk(-24, 40, reset), wk(-12, 50, reset), wk(0, 64, reset)];
  expect(burnRate(readings, WEEK)).toBe(1);
});

test("the rate never reaches back past the window's own start", () => {
  // The window started 10 h ago (reset in 158 h): the reading before it is left out.
  const reset = NOW + 158 * HOUR;
  const readings = [wk(-20, 90, reset - WEEK), wk(-10, 0, reset), wk(0, 20, reset)];
  expect(burnRate(readings, WEEK)).toBe(2);
});

test("readings spanning under an hour fall back to the average since the reset", () => {
  // Reset in 50 h: the week started 118 h ago, from 0; 12% since is 12/118 %/h.
  const reset = NOW + 50 * HOUR;
  expect(burnRate([wk(-0.5, 10, reset), wk(0, 12, reset)], WEEK)).toBeNull();
  expect(burnRate([wk(0, 12, reset)], WEEK)).toBeNull();
  expect(burnRate([], WEEK)).toBeNull();
  const state = windowState([wk(-0.5, 10, reset), wk(0, 12, reset)], WEEK, NOW);
  expect(state?.ratePerHour).toBe(12 / 118);
  expect(state?.rateFrom).toBe("reset");
  expect(state?.outcome).toBe("lasts");
  expect(state?.percent).toBe(12);
  // Two readings a day apart are the readings' own rate.
  expect(windowState([wk(-24, 0, reset), wk(0, 12, reset)], WEEK, NOW)?.rateFrom).toBe("readings");
});

test("no rate without a reset to count from, or under an hour into the window", () => {
  const none = windowState([wk(-0.5, 10, null), wk(0, 12, null)], WEEK, NOW);
  expect(none?.ratePerHour).toBeNull();
  expect(none?.rateFrom).toBeNull();
  expect(none?.outcome).toBe("unknown");
  // The week started 30 min ago.
  const fresh = windowState([wk(0, 3, NOW + WEEK - 0.5 * HOUR)], WEEK, NOW);
  expect(fresh?.ratePerHour).toBeNull();
});

test("an account read at 100 minutes after it started has a floor burn and a forecast", () => {
  // As on 28 Sep 03:32–03:37 CET: spent, reset in 21.4 h, two readings 5 min apart.
  const reset = NOW + 21.4 * HOUR;
  const readings = [wk(-5 / 60, 100, reset), wk(0, 100, reset)];
  const spent = windowState(readings, WEEK, NOW);
  expect(spent?.outcome).toBe("spent");
  expect(spent?.ratePerHour).toBeCloseTo(100 / (168 - 21.4), 9);
  expect(spent?.rateFrom).toBe("reset");
  expect(spent?.dryHours).toBeCloseTo(21.4, 9);
});

test("an account that reaches 100 before its reset runs dry, one that does not lasts", () => {
  // 80% at 1 %/h, reset in 50 h: out in 20 h, 30 h dry.
  const soon = NOW + 50 * HOUR;
  const dry = windowState([wk(-24, 56, soon), wk(0, 80, soon)], WEEK, NOW);
  expect(dry?.outcome).toBe("dry");
  expect(dry?.runsOutAt).toBe(NOW + 20 * HOUR);
  expect(dry?.dryHours).toBe(30);
  expect(dry?.atReset).toBeNull();
  // 50% at 0.25 %/h, reset in 100 h: 75% at the reset.
  const later = NOW + 100 * HOUR;
  const lasts = windowState([wk(-24, 44, later), wk(0, 50, later)], WEEK, NOW);
  expect(lasts?.outcome).toBe("lasts");
  expect(lasts?.atReset).toBe(75);
  expect(lasts?.dryHours).toBe(0);
  // 68 h of the 168 h week gone.
  expect(lasts?.elapsed).toBeCloseTo((68 / 168) * 100, 6);
});

test("an account at 100 is spent now, dry until its reset", () => {
  const reset = NOW + 22 * HOUR;
  const spent = windowState([wk(-24, 80, reset), wk(0, 100, reset)], WEEK, NOW);
  expect(spent?.outcome).toBe("spent");
  expect(spent?.dryHours).toBe(22);
  expect(windowState([], WEEK, NOW)).toBeNull();
});

test("the forecast climbs at its rate, stops at 100 and drops to 0 at each reset", () => {
  const points = forecastPoints(90, NOW, 1, NOW + 20 * HOUR, WEEK, NOW + 30 * HOUR);
  expect(points).toEqual([
    [NOW, 90],
    [NOW + 10 * HOUR, 100],
    [NOW + 20 * HOUR, 100],
    [NOW + 20 * HOUR, 0],
    [NOW + 30 * HOUR, 10],
  ]);
  expect(valueAt(points, NOW + 5 * HOUR)).toBe(95);
  expect(valueAt(points, NOW + 20 * HOUR)).toBe(0);
  expect(valueAt(points, NOW + 31 * HOUR)).toBeNull();
});

test("daily burn sums each account's rise per local day, a new window counted from 0", () => {
  const first = NOW + 100 * HOUR;
  const second = first + WEEK;
  // Local days (CET): Sat 26 from 23:00 UTC on the 25th, Sun 27 from 23:00 UTC on the 26th.
  const readings = [
    wk(-30, 60, first), // Sat 26 07:00 CET, the first on record
    wk(-20, 70, first), // Sat 17:00: +10
    wk(-5, 90, first), // Sun 08:00: +20
    wk(-4, 2, second), // Sun 09:00: the window reset, +2 from 0
    wk(-3, 5, second), // Sun 10:00: +3
    wk(-2, 4, second), // Sun 11:00: a fall is no burn
    wk(-10, 20, first, "b@x.com"), // Sun 03:00: b's first, nothing to rise from
    wk(-1, 26, first, "b@x.com"), // Sun 12:00: +6
  ].sort((a, b) => a.at - b.at);
  expect(dailyBurn(readings, NOW, CET)).toEqual([
    { start: Date.UTC(2026, 8, 25, 23), burn: 10 },
    { start: Date.UTC(2026, 8, 26, 23), burn: 31 },
  ]);
  expect(dailyBurn([], NOW, CET)).toEqual([]);
});

test("daily burn keeps the last 14 days", () => {
  const readings = Array.from({ length: 21 }, (_, k) => wk(-24 * (20 - k), k, null));
  const days = dailyBurn(readings, NOW, CET);
  expect(days).toHaveLength(14);
  expect(days.every((d) => d.burn === 1)).toBe(true);
});

test("the pool counts what each account has left, an account with no rate held", () => {
  const meta = (email: string): AccountMeta => ({
    email,
    label: email,
    startsNewSessions: false,
    windowMs: { "7d": WEEK, "5h": 5 * HOUR },
  });
  const reset = NOW + 50 * HOUR;
  // b has no reset to count a rate from: it is held.
  const readings = [
    wk(-2, 40, reset),
    wk(-0.5, 30, null, "b@x.com"),
    wk(0, 42, reset),
    wk(0, 30, null, "b@x.com"),
  ];
  const answer = forecast(readings, [meta("a@x.com"), meta("b@x.com"), meta("c@x.com")], NOW, CET);
  const [a, b, c] = answer.accounts;
  expect(a?.weekly?.ratePerHour).toBe(1);
  expect(a?.forecast.length).toBeGreaterThan(0);
  expect(b?.weekly?.ratePerHour).toBeNull();
  expect(b?.forecast).toEqual([]);
  expect(c?.weekly).toBeNull();
  // Now: a has 58 left, b 70 (c has no readings and is not counted).
  const k = (NOW - answer.grid.from) / HOUR;
  expect(answer.grid.pool[k]).toBe(128);
  // 10 h on: a at 52, b held at 30.
  expect(answer.grid.pool[k + 10]).toBe(118);
  // Past a's reset it has 99 left, climbing again from 0; b still held at 70.
  expect(answer.grid.pool[k + 51]).toBe(169);
  // The drawn lines: measured from the first moment both had a reading, then a's reset as a step.
  expect(answer.pool.measured).toEqual([
    [NOW - 0.5 * HOUR, 58.5 + 70],
    [NOW, 128],
  ]);
  expect(answer.pool.forecast.slice(0, 4)).toEqual([
    [NOW, 128],
    [NOW + 50 * HOUR, 78],
    [NOW + 50 * HOUR, 170],
    [NOW + AHEAD, 170 - (AHEAD - 50 * HOUR) / HOUR],
  ]);
  expect(answer.firstAt).toBe(NOW - 2 * HOUR);
  expect(b?.hourly[k + 10]).toBe(30);
  expect(c?.hourly.every((v) => v === null)).toBe(true);
  expect(a?.hourly[k + 10]).toBe(52);
});

test("the pool forecast refills a spent account to 100 left at its reset, never past", () => {
  // Two accounts spent now, reset in 10 h and 20 h, then burning 2 %/h again.
  const one = forecastPoints(100, NOW, 2, NOW + 10 * HOUR, WEEK, NOW + 30 * HOUR);
  const two = forecastPoints(100, NOW, 2, NOW + 20 * HOUR, WEEK, NOW + 30 * HOUR);
  const pool = poolForecast([one, two], NOW + 30 * HOUR);
  expect(pool).toEqual([
    [NOW, 0],
    [NOW + 10 * HOUR, 0],
    [NOW + 10 * HOUR, 100],
    [NOW + 20 * HOUR, 80],
    [NOW + 20 * HOUR, 180],
    [NOW + 30 * HOUR, 140],
  ]);
  expect(Math.max(...pool.map(([, v]) => v))).toBeLessThanOrEqual(200);
  expect(poolForecast([], NOW)).toEqual([]);
});
