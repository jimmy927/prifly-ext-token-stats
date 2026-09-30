import { expect, test } from "bun:test";
import {
  AHEAD,
  averageRate,
  burnRate,
  dailyBurn,
  forecast,
  forecastPoints,
  freeResetEffect,
  freeResetPool,
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
  // Its average since the reset at its first reading at 100, 5 min before the latest.
  expect(spent?.ratePerHour).toBeCloseTo(100 / (168 - 21.4 - 5 / 60), 9);
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

test("a spent account read at 100 for 1.7 h burns at the rate it ran out, and falls again after its reset", () => {
  // As on 28 Sep 03:32–05:14 CET: jimmy@artemisrec at 100 since the first reading, reset 29 Sep 01:00 CET.
  const reset = NOW + 19.8 * HOUR;
  const start = reset - WEEK;
  const readings = [wk(-1.7, 100, reset), wk(-1, 100, reset), wk(0, 100, reset)];
  // The readings rise at 0 %/h over 1.7 h; without a hit its first reading at 100 is a floor.
  expect(burnRate(readings, WEEK)).toBe(0);
  const floor = windowState(readings, WEEK, NOW);
  expect(floor?.ratePerHour).toBeCloseTo(100 / (168 - 19.8 - 1.7), 9);
  expect(floor?.rateFrom).toBe("reset");
  // With the transcripts' hit 100 h into the window: 1 %/h, how it ran out.
  const hitAt = start + 100 * HOUR;
  const spent = windowState(readings, WEEK, NOW, hitAt);
  expect(spent?.ratePerHour).toBe(1);
  expect(spent?.rateFrom).toBe("ran out");
  expect(spent?.outcome).toBe("spent");
  // The forecast and the pool use it: 30 h on, 10.2 h after the reset, it has used 10.2%.
  const meta: AccountMeta = {
    email: "a@x.com",
    label: "a",
    startsNewSessions: false,
    windowMs: { "7d": WEEK, "5h": 5 * HOUR },
    stale: false,
    freeResets: null,
  };
  const answer = forecast(readings, [meta], NOW, new Map([["a@x.com", hitAt]]));
  expect(answer.accounts[0]?.hourly[(NOW + 30 * HOUR - answer.grid.from) / HOUR]).toBeCloseTo(
    10.2,
    9,
  );
  expect(valueAt(answer.pool.forecast, reset + 10 * HOUR)).toBeCloseTo(90, 9);
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

test("the average rate is the mean of the accounts that have one", () => {
  expect(averageRate([1, null, 3])).toBe(2);
  expect(averageRate([null, null])).toBeNull();
  expect(averageRate([])).toBeNull();
});

test("every account is forecast at the average rate, its own shown beside it", () => {
  const meta = (email: string): AccountMeta => ({
    email,
    label: email,
    startsNewSessions: false,
    windowMs: { "7d": WEEK, "5h": 5 * HOUR },
    stale: false,
    freeResets: null,
  });
  const reset = NOW + 100 * HOUR;
  // a burns 1 %/h, b 3 %/h: both are forecast at 2 %/h.
  const readings = [
    wk(-10, 10, reset),
    wk(-10, 10, reset, "b@x.com"),
    wk(0, 20, reset),
    wk(0, 40, reset, "b@x.com"),
  ];
  const answer = forecast(readings, [meta("a@x.com"), meta("b@x.com")], NOW, new Map());
  const [a, b] = answer.accounts;
  expect(answer.averageRate).toBe(2);
  expect(a?.weekly?.ratePerHour).toBe(1);
  expect(b?.weekly?.ratePerHour).toBe(3);
  expect(a?.weekly?.forecastRate).toBe(2);
  expect(b?.weekly?.forecastRate).toBe(2);
  // At 2 %/h a runs out in 40 h, b in 30 h.
  expect(a?.weekly?.runsOutAt).toBe(NOW + 40 * HOUR);
  expect(b?.weekly?.runsOutAt).toBe(NOW + 30 * HOUR);
  expect(valueAt(a?.forecast ?? [], NOW + 10 * HOUR)).toBe(40);
});

test("the pool counts what each account has left, an account with no rate of its own at the average", () => {
  const meta = (email: string): AccountMeta => ({
    email,
    label: email,
    startsNewSessions: false,
    windowMs: { "7d": WEEK, "5h": 5 * HOUR },
    stale: false,
    freeResets: null,
  });
  const reset = NOW + 50 * HOUR;
  // b has no reset to count a rate from: it is held.
  const readings = [
    wk(-2, 40, reset),
    wk(-0.5, 30, null, "b@x.com"),
    wk(0, 42, reset),
    wk(0, 30, null, "b@x.com"),
  ];
  const answer = forecast(
    readings,
    [meta("a@x.com"), meta("b@x.com"), meta("c@x.com")],
    NOW,
    new Map(),
  );
  const [a, b, c] = answer.accounts;
  expect(a?.weekly?.ratePerHour).toBe(1);
  expect(a?.forecast.length).toBeGreaterThan(0);
  // b has no rate of its own: it is forecast at the average, a's 1 %/h.
  expect(b?.weekly?.ratePerHour).toBeNull();
  expect(b?.weekly?.forecastRate).toBe(1);
  expect(answer.averageRate).toBe(1);
  expect(c?.weekly).toBeNull();
  // Now: a has 58 left, b 70 (c has no readings and is not counted).
  const k = (NOW - answer.grid.from) / HOUR;
  expect(answer.grid.pool[k]).toBe(128);
  // 10 h on: a at 52, b at 40.
  expect(answer.grid.pool[k + 10]).toBe(108);
  // Past a's reset it has 99 left, climbing again from 0; b at 81.
  expect(answer.grid.pool[k + 51]).toBe(118);
  // The drawn lines: measured from the first moment both had a reading, then a's reset as a step.
  expect(answer.pool.measured).toEqual([
    [NOW - 0.5 * HOUR, 58.5 + 70],
    [NOW, 128],
  ]);
  // a's reset a step; b empty at 70 h.
  expect(answer.pool.forecast).toEqual([
    [NOW, 128],
    [NOW + 50 * HOUR, 28],
    [NOW + 50 * HOUR, 120],
    [NOW + 70 * HOUR, 80],
    [NOW + AHEAD, 100 - (AHEAD - 50 * HOUR) / HOUR],
  ]);
  expect(answer.firstAt).toBe(NOW - 2 * HOUR);
  // The chart starts at the first reading's hour, not 3 days back with nothing measured.
  expect(answer.grid.from).toBe(NOW - 2 * HOUR);
  // At its first hour only a has been read (b from half an hour ago).
  expect(answer.grid.pool[0]).toBe(60);
  // Readings older than 3 days: it starts 3 days back.
  const older = forecast([wk(-100, 5, reset), ...readings], [meta("a@x.com")], NOW, new Map());
  expect(older.grid.from).toBe(NOW - 3 * DAY);
  expect(b?.hourly[k + 10]).toBe(40);
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

test("a free reset on a spent account is used now and leaves the rest of the week at its burn", () => {
  // Spent, reset in 22 h; hit 100 h into the week gives 1 %/h: 22 h dry, 22% burnt after a reset, all covered.
  const reset = NOW + 22 * HOUR;
  const free = { left: 1, usableNow: true, endsAt: NOW + 5 * DAY };
  const hitAt = reset - WEEK + 100 * HOUR;
  const weekly = windowState([wk(-1, 100, reset), wk(0, 100, reset)], WEEK, NOW, hitAt);
  expect(freeResetEffect(free, weekly, NOW)).toEqual({
    usedAt: NOW,
    spentNow: true,
    dryHours: 22,
    coveredHours: 22,
    atReset: 22,
  });
});

test("a free reset on an account that runs dry later is used at its run-out", () => {
  // 80% at 1 %/h, reset in 50 h: out in 20 h, 30 h dry; a reset then covers all 30 h and ends the week at 30%.
  const reset = NOW + 50 * HOUR;
  const weekly = windowState([wk(-24, 56, reset), wk(0, 80, reset)], WEEK, NOW);
  const free = { left: 2, usableNow: false, endsAt: NOW + 5 * DAY };
  expect(freeResetEffect(free, weekly, NOW)).toEqual({
    usedAt: NOW + 20 * HOUR,
    spentNow: false,
    dryHours: 30,
    coveredHours: 30,
    atReset: 30,
  });
});

test("a free reset covers only part of the dry hours when 100% at the burn is used up first", () => {
  // 50% at 2 %/h, reset in 100 h: out in 25 h, 75 h dry; 100% lasts 50 h, so 50 h covered and the week ends at 100%.
  const reset = NOW + 100 * HOUR;
  const weekly = windowState([wk(-24, 2, reset), wk(0, 50, reset)], WEEK, NOW);
  expect(weekly?.ratePerHour).toBe(2);
  const effect = freeResetEffect({ left: 1, usableNow: true, endsAt: reset }, weekly, NOW);
  expect(effect?.dryHours).toBe(75);
  expect(effect?.coveredHours).toBe(50);
  expect(effect?.atReset).toBe(100);
});

test("no free reset, none left, or no rate gives no effect, and the pool ignores them", () => {
  const reset = NOW + 50 * HOUR;
  const weekly = windowState([wk(-24, 56, reset), wk(0, 80, reset)], WEEK, NOW);
  expect(freeResetEffect(null, weekly, NOW)).toBeNull();
  expect(freeResetEffect({ left: 0, usableNow: true, endsAt: reset }, weekly, NOW)).toBeNull();
  const noRate = windowState([wk(0, 80, null)], WEEK, NOW);
  expect(freeResetEffect({ left: 1, usableNow: true, endsAt: reset }, noRate, NOW)).toBeNull();
  const meta = (email: string, freeResets: AccountMeta["freeResets"]): AccountMeta => ({
    email,
    label: email,
    startsNewSessions: false,
    windowMs: { "7d": WEEK, "5h": 5 * HOUR },
    stale: false,
    freeResets,
  });
  const readings = [
    wk(-24, 56, reset),
    wk(0, 80, reset),
    wk(-24, 56, reset, "b@x.com"),
    wk(0, 80, reset, "b@x.com"),
  ];
  const none = forecast(readings, [meta("a@x.com", null), meta("b@x.com", null)], NOW, new Map());
  expect(none.freeResetPool).toBeNull();
  expect(none.accounts.every((a) => a.freeResetEffect === null)).toBe(true);
  // One of the two has a reset: the pool's 60 dry hours drop by its 30 covered.
  const free = { left: 1, usableNow: true, endsAt: reset };
  const one = forecast(readings, [meta("a@x.com", free), meta("b@x.com", null)], NOW, new Map());
  expect(one.freeResetPool).toEqual({
    dryHours: 30,
    coveredHours: 30,
    poolDryHours: 60,
    poolDryHoursAfter: 30,
  });
  expect(freeResetPool(one.accounts)).toEqual(one.freeResetPool);
});

test("a stale account is still forecast from its last readings and says so", () => {
  const meta = (stale: boolean): AccountMeta => ({
    email: "a@x.com",
    label: "a@x.com",
    startsNewSessions: false,
    windowMs: { "7d": WEEK, "5h": 5 * HOUR },
    stale,
    freeResets: null,
  });
  const reset = NOW + 100 * HOUR;
  const readings = [wk(-10, 10, reset), wk(0, 20, reset)];
  const fresh = forecast(readings, [meta(false)], NOW, new Map()).accounts[0];
  const stale = forecast(readings, [meta(true)], NOW, new Map()).accounts[0];
  expect(fresh?.stale).toBe(false);
  expect(stale?.stale).toBe(true);
  expect(stale?.weekly).not.toBeNull();
  expect(stale?.weekly?.percent).toBe(20);
  expect(stale?.weekly).toEqual(fresh?.weekly ?? null);
});
