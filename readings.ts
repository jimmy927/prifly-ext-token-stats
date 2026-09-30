/**
 * Readings of each account's plan limits, kept so the Forecast view can tell
 * how fast they are being spent. prifly's usage pollers only know the latest
 * percent (`api.accounts()`); a rate needs the ones before it.
 *
 * Every 5 minutes the extension asks `api.accounts()`, and an account whose
 * `readAt` moved since its last stored reading gets one reading per limit it
 * follows — the weekly one ("7d") and the 5-hour one ("5h"). They are
 * appended to `cache/readings.jsonl`, one JSON object a line, so a save
 * writes only the new lines. Readings older than 30 days are dropped when the
 * file is loaded, and the file rewritten without them at most once a day.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { AccountFreeReset, AccountInfo } from "./prifly-api";

const DAY = 86_400_000;
export const RETAIN = 30 * DAY;

/** The limits a reading is kept for: the weekly one, all models, and the 5-hour session. */
export const WINDOWS = ["7d", "5h"] as const;
export type Window = (typeof WINDOWS)[number];

export type Reading = {
  /** When prifly read it (the account's `readAt`), epoch ms. */
  at: number;
  email: string;
  label: Window;
  usedPercent: number;
  resetsAt: number | null;
};

/** An account as the latest `accounts()` call named it, for the view. */
export type AccountMeta = {
  email: string;
  label: string;
  startsNewSessions: boolean;
  /**
   * Each followed window's length, from its limit; absent when the account has
   * never had such a limit. An answer with none (a failed read) keeps the last
   * one known, so the stored readings still make a forecast.
   */
  windowMs: Partial<Record<Window, number>>;
  /**
   * The answer carried no limits now (a failed read) while readings are stored:
   * the row is drawn from the last reading, not a current one.
   */
  stale: boolean;
  /** Its free resets ("Reset for free", claude.ai Settings → Usage); null with none. */
  freeResets: AccountFreeReset | null;
};

const isWindow = (label: string): label is Window => (WINDOWS as readonly string[]).includes(label);

function parseLine(line: string): Reading | null {
  try {
    return JSON.parse(line) as Reading;
  } catch (caught) {
    // A line cut short by a host killed mid-append: the rest of the file stands.
    if (caught instanceof SyntaxError) return null;
    throw caught;
  }
}

export class Readings {
  private readings: Reading[] = [];
  /** The newest stored `at` per email: only a newer `readAt` is appended. */
  private readonly latest = new Map<string, number>();
  /** The connected accounts, as the last `take` saw them. */
  accounts: AccountMeta[] = [];

  private readonly file: string;

  constructor(file: string) {
    this.file = file;
  }

  /** Every reading kept, oldest first. */
  all(): readonly Reading[] {
    return this.readings;
  }

  /** When the newest reading was taken, or null before the first. */
  get newestAt(): number | null {
    const newest = Math.max(...this.latest.values());
    return Number.isFinite(newest) ? newest : null;
  }

  /** Read the file, dropping what is older than 30 days. */
  load(now: number): void {
    if (!existsSync(this.file)) return;
    const lines = readFileSync(this.file, "utf8").split("\n");
    const read = lines.filter((line) => line !== "").map(parseLine);
    this.readings = read
      .filter((r): r is Reading => r !== null && r.at >= now - RETAIN)
      .sort((a, b) => a.at - b.at);
    for (const r of this.readings) this.latest.set(r.email, Math.max(this.latestOf(r.email), r.at));
    if (this.readings.length !== read.length) this.rewrite();
  }

  /** Take what `accounts()` answered; returns how many readings were added. */
  take(accounts: AccountInfo[], now: number): number {
    const before = new Map(this.accounts.map((meta) => [meta.email, meta]));
    this.accounts = accounts.map((account) => {
      const followed = account.limits.filter((l) => isWindow(l.label));
      const windowMs: AccountMeta["windowMs"] = {
        ...before.get(account.email)?.windowMs,
        ...Object.fromEntries(followed.map((l) => [l.label, l.windowMs])),
      };
      return {
        email: account.email,
        label: account.label,
        startsNewSessions: account.startsNewSessions,
        windowMs,
        // As answered: null is also how prifly says "none", so a kept one could outlive its grant.
        freeResets: account.freeResets,
        stale: (account.readAt === null || followed.length === 0) && this.latest.has(account.email),
      };
    });
    const added: Reading[] = [];
    for (const account of accounts) {
      if (account.readAt === null || account.readAt <= this.latestOf(account.email)) continue;
      for (const limit of account.limits) {
        if (!isWindow(limit.label)) continue;
        added.push({
          at: account.readAt,
          email: account.email,
          label: limit.label,
          usedPercent: limit.usedPercent,
          resetsAt: limit.resetsAt,
        });
      }
      this.latest.set(account.email, account.readAt);
    }
    if (added.length > 0) {
      this.readings.push(...added);
      this.readings.sort((a, b) => a.at - b.at);
      mkdirSync(dirname(this.file), { recursive: true });
      appendFileSync(this.file, added.map((r) => `${JSON.stringify(r)}\n`).join(""));
    }
    // A day past the retention, the file is rewritten without the old ones — not at every take.
    const oldest = this.readings[0];
    if (oldest !== undefined && oldest.at < now - RETAIN - DAY) {
      this.readings = this.readings.filter((r) => r.at >= now - RETAIN);
      this.rewrite();
    }
    return added.length;
  }

  private latestOf(email: string): number {
    return this.latest.get(email) ?? Number.NEGATIVE_INFINITY;
  }

  private rewrite(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, this.readings.map((r) => `${JSON.stringify(r)}\n`).join(""));
  }
}
