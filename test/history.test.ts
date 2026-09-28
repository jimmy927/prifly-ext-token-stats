import { expect, test } from "bun:test";
import { costHistory, limitHistory, ownerOf } from "../history";
import type { LimitHit } from "../parse";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
// CET (UTC+2 in summer) as the local wall clock: 2 Oct 00:00 CET = 1 Oct 22:00 UTC.
const huboten = Date.UTC(2026, 9, 1, 22);
const jimmy = Date.UTC(2026, 9, 3, 10);
const now = Date.UTC(2026, 8, 28, 10);

test("a refusal goes to the account whose reset it names, not the one the transcript lagged on", () => {
  // 27 Sep 22:03 CET: the transcript still said jimmy, the reset was huboten's Oct 2 00:00.
  const hit: LimitHit = { ts: Date.UTC(2026, 8, 27, 20, 3), account: "jimmy", resetsAt: huboten };
  const resets = new Map<string, number | null>([
    ["jimmy", jimmy],
    ["huboten", huboten + 250],
  ]);
  expect(ownerOf(hit, resets)).toBe("huboten");
  // A reset a whole week earlier is the same weekly cycle.
  expect(ownerOf({ ...hit, resetsAt: huboten - WEEK }, resets)).toBe("huboten");
  // Its own reset wins when two line up.
  expect(
    ownerOf(
      hit,
      new Map([
        ["jimmy", huboten],
        ["huboten", huboten],
      ]),
    ),
  ).toBe("jimmy");
  // Nothing lines up: the transcript's account, if prifly holds it; otherwise none.
  expect(ownerOf({ ...hit, resetsAt: huboten + 5 * HOUR }, resets)).toBe("jimmy");
  expect(ownerOf({ ...hit, account: "gone", resetsAt: huboten + 5 * HOUR }, resets)).toBeNull();
});

test("windows come from the reading's reset and each refusal's, merged, with the first hit", () => {
  const accounts = [
    { email: "jimmy", resetsAt: jimmy },
    { email: "huboten", resetsAt: huboten },
    { email: "new", resetsAt: null },
  ];
  const hits: LimitHit[] = [
    { ts: Date.UTC(2026, 8, 27, 20, 3), account: "jimmy", resetsAt: huboten },
    { ts: Date.UTC(2026, 8, 27, 21, 0), account: "huboten", resetsAt: huboten },
    { ts: Date.UTC(2026, 8, 25, 8, 0), account: "jimmy", resetsAt: jimmy - WEEK },
    // Older than the 7 days and ending before them: dropped.
    { ts: Date.UTC(2026, 8, 10), account: "jimmy", resetsAt: jimmy - 3 * WEEK },
    { ts: Date.UTC(2026, 8, 27), account: "stranger", resetsAt: huboten + 5 * HOUR },
    { ts: Date.UTC(2026, 8, 1), account: "stranger", resetsAt: huboten + 5 * HOUR },
  ];
  const got = limitHistory(hits, accounts, now);
  expect(got.from).toBe(now - WEEK);
  expect(got.unplaced).toBe(1);
  expect(got.windows).toEqual([
    {
      email: "jimmy",
      start: jimmy - 2 * WEEK,
      end: jimmy - WEEK,
      hitAt: Date.UTC(2026, 8, 25, 8),
      refusals: 1,
      lastRefusalAt: Date.UTC(2026, 8, 25, 8),
    },
    {
      email: "jimmy",
      start: jimmy - WEEK,
      end: jimmy,
      hitAt: null,
      refusals: 0,
      lastRefusalAt: null,
    },
    {
      email: "huboten",
      start: huboten - WEEK,
      end: huboten,
      hitAt: Date.UTC(2026, 8, 27, 20, 3),
      refusals: 2,
      lastRefusalAt: Date.UTC(2026, 8, 27, 21),
    },
  ]);
});

test("the cost history lines up with prifly's accounts and leaves others out", () => {
  const days = [0, DAY, 2 * DAY];
  const got = costHistory(
    days,
    [
      { key: "b", values: [1, 2, 3] },
      { key: "stranger", values: [9, 9, 9] },
    ],
    ["a", "b"],
  );
  expect(got).toEqual({
    days,
    accounts: [
      { email: "a", values: [0, 0, 0] },
      { email: "b", values: [1, 2, 3] },
    ],
  });
});
