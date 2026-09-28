import { expect, test } from "bun:test";
import { burndownNote, burndownSpan } from "../panel/burndown.js";
import { burnCell, runwayBanner } from "../panel/forecast.js";

const w = (outcome, dryHours, ratePerHour, rateFrom) => ({
  outcome,
  dryHours,
  ratePerHour,
  rateFrom,
});

test("the banner counts spent and dry accounts, and the burn column shows each one's burn", () => {
  // As on 28 Sep 03:40 CET: four spent (92 + 45 + 21 + 71 h dry), one at 66% on its average since the reset.
  const read = [
    w("spent", 92.3, 1.32, "reset"),
    w("dry", 101.8, 1.51, "reset"),
    w("spent", 45.4, 0.82, "reset"),
    w("spent", 21.4, 0.68, "reset"),
    w("spent", 71.4, 1.04, "reset"),
  ];
  const { ok, html } = runwayBanner(read);
  expect(ok).toBe(false);
  expect(html).toContain("<b>5</b> of <b>5</b> accounts are out before their weekly reset");
  expect(html).toContain("4 spent now, 1 run dry at their burn");
  expect(html).toContain("<b>332</b> account-hours");
  for (const r of read) expect(burnCell(r)).not.toContain("—");
  expect(burnCell(read[0])).toBe('≥ 1.32 %/h<span class="small">avg since reset</span>');
  expect(burnCell(read[1])).toBe('1.51 %/h<span class="small">avg since reset</span>');
  expect(burnCell(w("lasts", 0, 0.5, "readings"))).toContain("last 24 h");
});

test("an account with no burn is named in the banner, not counted as lasting", () => {
  const { ok, html } = runwayBanner([w("lasts", 0, 0.2, "readings"), w("unknown", 0, null, null)]);
  expect(ok).toBe(true);
  expect(html).toContain("1 of <b>2</b> accounts last");
  expect(html).toContain("1 has too few readings to tell");
  expect(burnCell(w("unknown", 0, null, null))).toContain("—");
});

test("the burn-down note says what each mode draws and when readings began", () => {
  const now = Date.UTC(2026, 8, 28, 1, 40);
  // As on 28 Sep: readings began 03:32 CET, the chart starts at 03:00.
  const answer = {
    now,
    firstAt: now - 8 * 60_000,
    grid: { from: Date.UTC(2026, 8, 28, 1) },
    accounts: [{}, {}, {}, {}, {}],
  };
  expect(burndownNote("pool", answer)).toContain("at most 500%");
  expect(burndownNote("pool", answer)).toContain("refills to 100");
  expect(burndownNote("accounts", answer)).toContain("drops to 0 at its weekly reset");
  expect(burndownNote("accounts", answer)).toContain("Readings began");
  expect(burndownSpan(answer)).toBe("Weekly %, 8 min measured, 6 days ahead");
  // Readings from before the 3 days: the chart starts 3 days back and says so.
  const old = { ...answer, firstAt: now - 4 * 86_400_000, grid: { from: now - 3 * 86_400_000 } };
  expect(burndownNote("accounts", old)).not.toContain("Readings began");
  expect(burndownSpan(old)).toBe("Weekly %, 3 days measured, 6 days ahead");
  expect(burndownSpan({ ...answer, firstAt: now - 5 * 3_600_000, grid: { from: 0 } })).toBe(
    "Weekly %, 5 h measured, 6 days ahead",
  );
});
