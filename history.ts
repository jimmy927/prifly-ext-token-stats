/**
 * The Forecast view's past before the readings: no weekly % survives from
 * then (prifly keeps only each account's last read), but two things do, from
 * the transcripts. The minutes an account hit its weekly limit — Claude Code
 * writes each refused call with the reset it was told — and so the weekly
 * windows those resets end; and the cost per day, in dollars at API prices.
 *
 * Neither is turned into %: the cost to reach 100% differed 7.5-fold between
 * accounts and weeks on 15–27 Sep 2026 ($469 to $3,541).
 */

import type { LimitHit } from "./parse";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

/** How far back the Burn-down shows weekly windows and limit hits. */
export const HISTORY = 7 * DAY;
/**
 * Two resets this close are one. A reading's reset carries milliseconds and
 * a refusal's whole seconds; an account's reset otherwise stays on the hour.
 */
const SAME_RESET = 30 * 60_000;

/** One weekly window of one account, as far as a reading or a refusal tells it. */
export type LimitWindow = {
  email: string;
  start: number;
  /** Its reset. */
  end: number;
  /** The first refusal in it: the minute the account hit 100%. null when none was written down. */
  hitAt: number | null;
  refusals: number;
  lastRefusalAt: number | null;
};

export type LimitHistory = {
  /** Where the past shown starts: `HISTORY` back, on the hour. */
  from: number;
  /** By account in the order given, oldest first. */
  windows: LimitWindow[];
  /** Refusals in the stretch no account held by prifly could be given. */
  unplaced: number;
};

/** Dollars at API prices per local day, oldest first, per account held by prifly. */
export type CostHistory = {
  days: number[];
  accounts: { email: string; values: number[] }[];
};

/** How far apart two resets are, a whole number of weeks aside. */
function offWeek(a: number, b: number): number {
  const d = (((a - b) % WEEK) + WEEK) % WEEK;
  return Math.min(d, WEEK - d);
}

/**
 * The account a refusal belongs to: the transcript's, unless its reset lines
 * up with another account's weekly reset and not its own — a switch made
 * mid-session shows in the transcript only at the next resume. null when it
 * is none of `resets`' accounts.
 */
export function ownerOf(hit: LimitHit, resets: ReadonlyMap<string, number | null>): string | null {
  const lined = [...resets]
    .filter(([, r]) => r !== null && offWeek(r, hit.resetsAt) <= SAME_RESET)
    .map(([email]) => email);
  if (lined.includes(hit.account)) return hit.account;
  if (lined.length === 1) return lined[0] ?? null;
  return lined.length === 0 && resets.has(hit.account) ? hit.account : null;
}

/**
 * Each account's weekly windows that reach into the last `HISTORY`: the one
 * its latest reading is in, and each one a refusal names. None is inferred
 * from another by adding weeks: resets have moved (n49's from Sat 26 Sep
 * 08:00 to Thu 1 Oct 03:00 CET).
 */
export function limitHistory(
  hits: readonly LimitHit[],
  accounts: readonly { email: string; resetsAt: number | null }[],
  now: number,
): LimitHistory {
  const from = Math.floor((now - HISTORY) / HOUR) * HOUR;
  const resets = new Map(accounts.map((a) => [a.email, a.resetsAt]));
  const windows = new Map<string, LimitWindow[]>(accounts.map((a) => [a.email, []]));
  const windowOf = (email: string, end: number): LimitWindow => {
    const own = windows.get(email) ?? [];
    const found = own.find((w) => Math.abs(w.end - end) <= SAME_RESET);
    if (found !== undefined) return found;
    const made = { email, start: end - WEEK, end, hitAt: null, refusals: 0, lastRefusalAt: null };
    own.push(made);
    return made;
  };
  for (const a of accounts) if (a.resetsAt !== null) windowOf(a.email, a.resetsAt);
  let unplaced = 0;
  for (const hit of hits) {
    const owner = ownerOf(hit, resets);
    if (owner === null) {
      if (hit.ts >= from) unplaced += 1;
      continue;
    }
    const w = windowOf(owner, hit.resetsAt);
    w.hitAt = Math.min(w.hitAt ?? hit.ts, hit.ts);
    w.lastRefusalAt = Math.max(w.lastRefusalAt ?? hit.ts, hit.ts);
    w.refusals += 1;
  }
  const shown = [...windows.values()].flatMap((own) =>
    own.filter((w) => w.end > from).sort((a, b) => a.start - b.start),
  );
  return { from, windows: shown, unplaced };
}

/** The cost series by account, lined up with prifly's accounts; any other account's calls are left out. */
export function costHistory(
  days: readonly number[],
  series: readonly { key: string; values: readonly number[] }[],
  emails: readonly string[],
): CostHistory {
  const byKey = new Map(series.map((s) => [s.key, s.values]));
  return {
    days: [...days],
    accounts: emails.map((email) => ({
      email,
      values: [...(byKey.get(email) ?? days.map(() => 0))],
    })),
  };
}
