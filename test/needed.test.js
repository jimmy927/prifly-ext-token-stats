import { expect, test } from "bun:test";
import { accountsNeeded } from "../panel/forecast.js";

const days = (...burns) => burns.map((burn, k) => ({ start: k, burn }));

test("accounts needed averages the full days, today left out, plus headroom", () => {
  // Last 7 full days average 100% a day: 7 accounts' worth a week; with 20% headroom 8.4 → 9.
  const daily = days(500, 100, 100, 100, 100, 100, 100, 100, 999);
  expect(accountsNeeded(daily, 7, 20)).toEqual({ avg: 100, perWeek: 7, need: 9, fullDays: 7 });
  // Exactly 7 with no headroom is 7, not 8.
  expect(accountsNeeded(daily, 7, 0)?.need).toBe(7);
  // Fewer full days than asked for: the ones there are.
  expect(accountsNeeded(days(50, 150, 10), 14, 0)).toEqual({
    avg: 100,
    perWeek: 7,
    need: 7,
    fullDays: 2,
  });
  // Only today: no full day yet.
  expect(accountsNeeded(days(40), 7, 20)).toBeNull();
});
