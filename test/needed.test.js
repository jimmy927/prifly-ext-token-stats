import { expect, test } from "bun:test";
import { accountsNeeded, averagedFrom } from "../panel/forecast.js";
import { dayName } from "../panel/format.js";

const DAY = 86_400_000;
const days = (...burns) =>
  burns.map((burn, k) => ({ start: k * DAY, burn, reconstructed: 0, missing: [] }));

test("accounts needed averages the full days, today left out, plus headroom", () => {
  // Last 7 full days average 100% a day: 7 accounts' worth a week; with 20% headroom 8.4 → 9.
  const daily = days(500, 100, 100, 100, 100, 100, 100, 100, 999);
  expect(accountsNeeded(daily, 7, 20, 0)).toEqual({
    avg: 100,
    perWeek: 7,
    need: 9,
    fullDays: 7,
    rebuilt: [],
    left: [],
  });
  // Exactly 7 with no headroom is 7, not 8.
  expect(accountsNeeded(daily, 7, 0, 0)?.need).toBe(7);
  // Fewer full days than asked for: the ones there are.
  expect(accountsNeeded(days(50, 150, 10), 14, 0, 0)).toMatchObject({
    avg: 100,
    perWeek: 7,
    need: 7,
    fullDays: 2,
  });
  // Only today: no full day yet.
  expect(accountsNeeded(days(40), 7, 20, 0)).toBeNull();
});

test("reconstructed days count towards the average, partial ones do not", () => {
  // Readings began at day 3's midnight: days 0–2 are reconstructed, day 1 partial, day 3 read, day 4 today.
  const daily = days(60, 5, 80, 100, 7);
  daily[1].missing = ["b@x.com"];
  const n = accountsNeeded(daily, 7, 0, 3 * DAY);
  expect(n).toMatchObject({ avg: 80, fullDays: 3, rebuilt: [0, 2 * DAY], left: [DAY] });
  expect(averagedFrom(n)).toBe(
    `accounts' worth of weekly limit per week; ${dayName(0)}, ${dayName(2 * DAY)} reconstructed from the transcripts; ${dayName(DAY)} left out, partial`,
  );
  // Readings that began during day 3 leave its start reconstructed too.
  expect(accountsNeeded(daily, 7, 0, 3 * DAY + 5)?.rebuilt).toEqual([0, 2 * DAY, 3 * DAY]);
  // Every day partial: nothing to average.
  const gaps = days(9, 9).map((d) => ({ ...d, missing: ["b"] }));
  expect(accountsNeeded(gaps, 7, 0, DAY)).toBeNull();
});
