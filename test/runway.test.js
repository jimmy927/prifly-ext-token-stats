import { expect, test } from "bun:test";
import { burndownNote, burndownSpan } from "../panel/burndown-words.js";
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
    history: { from: now - 7 * 86_400_000, windows: [], unplaced: 0 },
    past: { curves: [], per100: null, band: 0.3 },
  };
  expect(burndownNote("pool", answer)).toContain("at most 500%");
  expect(burndownNote("pool", answer)).toContain("refills to 100");
  expect(burndownNote("pool", answer)).toContain("the sum of each one's weekly % left");
  expect(burndownNote("accounts", answer)).toContain(
    "has left: 100% at its reset, falling at its burn, stopping at 0% (empty) and jumping back to 100% at its next reset",
  );
  expect(burndownNote("accounts", answer)).toContain("Readings began");
  expect(burndownSpan(answer)).toBe("Weekly % left, 8 min measured, 6 days ahead");
  // Readings from before the 3 days: the chart starts 3 days back and says so.
  const old = { ...answer, firstAt: now - 4 * 86_400_000, grid: { from: now - 3 * 86_400_000 } };
  expect(burndownNote("accounts", old)).not.toContain("Readings began");
  expect(burndownSpan(old)).toBe("Weekly % left, 3 days measured, 6 days ahead");
  expect(burndownSpan({ ...answer, firstAt: now - 5 * 3_600_000, grid: { from: 0 } })).toBe(
    "Weekly % left, 5 h measured, 6 days ahead",
  );
  expect(burndownNote("accounts", answer)).not.toContain("lane");
});

test("with weekly windows from the transcripts the header and note say the chart reaches back", () => {
  const now = Date.UTC(2026, 8, 28, 1, 40);
  const window = { email: "a@x.com", start: now - 5 * 86_400_000, end: now + 2 * 86_400_000 };
  const answer = {
    now,
    firstAt: now - 8 * 60_000,
    grid: { from: Date.UTC(2026, 8, 28, 1) },
    accounts: [{}, {}],
    history: {
      from: now - 7 * 86_400_000,
      windows: [
        { ...window, hitAt: now - 86_400_000, refusals: 3, lastRefusalAt: now - 3_600_000 },
      ],
      unplaced: 2,
    },
    past: { curves: [], per100: null, band: 0.3 },
  };
  expect(burndownSpan(answer)).toBe(
    "Weekly % left, 8 min measured, 6 days ahead · weekly windows 7 days back",
  );
  const note = burndownNote("accounts", answer);
  expect(note).toContain("where the % lines start");
  expect(note).toContain("none exists before the readings");
  expect(note).toContain("2 refusals in the last 7 days matched no account");
  expect(note).not.toContain("where the chart starts");
  // With a window reconstructed from its hit, the header and note say so and name the weighting.
  const rebuilt = { ...answer, past: { curves: [{ email: "a@x.com" }], per100: null, band: 0.3 } };
  expect(burndownSpan(rebuilt)).toBe(
    "Weekly % left, 8 min measured, 6 days ahead · 7 days back, reconstructed from when accounts ran out",
  );
  expect(burndownNote("accounts", rebuilt)).toContain("dotted lines are reconstructed");
  expect(burndownNote("accounts", rebuilt)).toContain(
    "falls from 100% left at its reset to 0% at the minute it ran out",
  );
  expect(burndownNote("accounts", rebuilt)).toContain("Opus 5.5 and Fable counted ×2");
  expect(burndownNote("pool", rebuilt)).toContain("where every account has one");
  expect(burndownNote("accounts", rebuilt)).not.toContain("none exists before the readings");
  expect(burndownNote("accounts", rebuilt)).toContain("never ran out has no known end");
  // With a window that never ran out estimated, the header, the note and its average say so.
  const guessed = {
    ...answer,
    past: {
      curves: [
        { email: "a@x.com", anchor: "hit" },
        { email: "a@x.com", anchor: "estimate" },
      ],
      per100: 2412.4,
      band: 0.3,
    },
  };
  expect(burndownSpan(guessed)).toBe(
    "Weekly % left, 8 min measured, 6 days ahead · 7 days back, reconstructed from when accounts ran out, estimated where they never did",
  );
  const poolNote = burndownNote("pool", guessed);
  expect(poolNote).toContain("each counted once (2,412 weighted $)");
  expect(poolNote).toContain(
    "the band is ±30%, the leave-one-out error of that average being 29% RMS",
  );
  expect(poolNote).toContain("its band the sum of theirs");
  expect(burndownNote("accounts", guessed)).not.toContain("its band the sum of theirs");
});
