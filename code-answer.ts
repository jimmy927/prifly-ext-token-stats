/**
 * The Code view's one question: token spend and lines of code added, on the
 * same buckets, for every repository or for one, and per repository in a
 * table with the dollars each thousand lines cost.
 *
 * Spend is the Usage view's (`Answerer.spend`), repository by repository, so
 * it already holds a repository's worktrees and the calls credited to it by
 * what a session wrote (`store.ts`). Lines are the default branch's commits
 * (`git.ts`), placed in a bucket by their committer time. A repository with
 * spend and no checkout on this machine has no lines: `null`, shown as "—".
 *
 * Beside them, the reader's active time (`presence.ts`): the hours in front
 * of Claude, per repository of the session replied to next, on the same
 * buckets, and the hours each thousand lines took.
 */

import { type Answerer, type Row, readParams, type Series } from "./answer";
import type { Commit } from "./git";
import type { LinesSource } from "./git-cache";
import { perKSeries, type RatioSeries } from "./per-k";
import { floorTo, type QueryParams } from "./query";

export type CodeParams = QueryParams & {
  /** The one repository shown, or null for all. */
  repo: string | null;
  /** One line of each chart per repository, or one for the total. */
  byRepo: boolean;
};

export type CodeRow = {
  key: string;
  label: string;
  slot: number;
  tone: string | null;
  /** Dollars at API list prices in the stretch. */
  spend: number;
  /** Lines of code added; null where this machine has no checkout of the repository. */
  lines: number | null;
  /** Dollars per 1,000 lines; null without lines. */
  perK: number | null;
  /** The reader's active hours in the stretch. */
  hours: number;
  /** Active hours per 1,000 lines; null without lines. */
  hoursPerK: number | null;
  /** Its part of all repositories' spend and lines, 0 to 1. */
  shareSpend: number;
  shareLines: number | null;
};

export type CodeAnswer = {
  from: number;
  to: number;
  bucket: number;
  buckets: number[];
  repo: string | null;
  byRepo: boolean;
  /** Every repository there is spend or lines for, biggest spend first. */
  repos: string[];
  /** The three charts' series: the same keys in the same order, so a repository keeps its colour. */
  cost: Series[];
  lines: Series[];
  /** Active hours per bucket. */
  hours: Series[];
  /** Dollars per 1,000 lines over a trailing day, for all shown repositories together (`per-k.ts`). */
  perK: RatioSeries;
  /** The same, one line to each of the repositories with the most spend that added lines. */
  perKByRepo: RatioSeries[];
  /** Active hours per 1,000 lines over a trailing day, for all shown repositories together. */
  hoursPerK: RatioSeries;
  /**
   * The shown repository's, or all repositories'; `perK` and `hoursPerK`
   * count only the spend and hours that have lines to them.
   */
  totals: {
    spend: number;
    lines: number;
    perK: number | null;
    hours: number;
    hoursPerK: number | null;
  };
  rows: CodeRow[];
  /** False until git has been read once: lines may then be missing. */
  ready: boolean;
};

/** The window's query: `repo` the one repository ("" for all) and `by=repo` a line each. */
export function readCodeParams(query: Record<string, string>, now: number): CodeParams {
  const repo = query["repo"];
  return {
    ...readParams(query, now),
    repo: repo === undefined || repo === "" ? null : repo,
    byRepo: query["by"] === "repo",
  };
}

/** A repository's lines per bucket, and their sum. */
function bucketLines(
  commits: readonly Commit[],
  start: number,
  to: number,
  width: number,
  count: number,
  tzMs: number,
): number[] {
  const values = new Array<number>(count).fill(0);
  for (const [ts, lines] of commits) {
    if (ts < start || ts >= to) continue;
    const at = Math.floor((floorTo(ts, width, tzMs) - start) / width);
    if (at >= 0 && at < count) values[at] = (values[at] ?? 0) + lines;
  }
  return values;
}

const sum = (values: readonly number[]) => values.reduce((a, b) => a + b, 0);
const add = (into: number[], values: readonly number[]) => {
  for (const [k, v] of values.entries()) into[k] = (into[k] ?? 0) + v;
};

type Entry = {
  name: string;
  slot: number;
  tone: string | null;
  cost: number[];
  lines: number[];
  hours: number[];
};

/** The largest spend first, then the most lines; the rest by name. */
const bySize = (a: Entry, b: Entry) =>
  sum(b.cost) - sum(a.cost) || sum(b.lines) - sum(a.lines) || (a.name < b.name ? -1 : 1);

function seriesOf(
  key: string,
  label: string,
  entry: Entry,
  of: "cost" | "lines" | "hours",
): Series {
  const values = entry[of];
  return { key, label, slot: entry.slot, tone: entry.tone, values, total: sum(values) };
}

/** One line for all `entries`, or one to each of the biggest `top` and "N more" for the rest. */
function chartSeries(entries: Entry[], byRepo: boolean, top: number, label: string, width: number) {
  const ranked = [...entries].sort(bySize);
  const shown = byRepo ? ranked.slice(0, top) : [];
  const rest = byRepo ? ranked.slice(top) : ranked;
  const cost: Series[] = shown.map((e) => seriesOf(e.name, e.name, e, "cost"));
  const lines: Series[] = shown.map((e) => seriesOf(e.name, e.name, e, "lines"));
  const hours: Series[] = shown.map((e) => seriesOf(e.name, e.name, e, "hours"));
  if (rest.length === 0) return { cost, lines, hours };
  const together: Entry = {
    name: byRepo ? "\u0000other" : "all",
    slot: byRepo ? -1 : 0,
    tone: null,
    cost: new Array<number>(width).fill(0),
    lines: new Array<number>(width).fill(0),
    hours: new Array<number>(width).fill(0),
  };
  for (const e of rest) {
    add(together.cost, e.cost);
    add(together.lines, e.lines);
    add(together.hours, e.hours);
  }
  const name = byRepo ? `${rest.length} more` : label;
  return {
    cost: [...cost, seriesOf(together.name, name, together, "cost")],
    lines: [...lines, seriesOf(together.name, name, together, "lines")],
    hours: [...hours, seriesOf(together.name, name, together, "hours")],
  };
}

function rowsOf(
  spend: readonly Row[],
  linesOf: Map<string, number | null>,
  hoursOf: Map<string, number>,
): CodeRow[] {
  const byName = new Map(spend.map((r) => [r.key, r]));
  const names = new Set([
    ...byName.keys(),
    ...[...linesOf].filter(([, n]) => n).map(([k]) => k),
    ...[...hoursOf].filter(([, h]) => h > 0).map(([k]) => k),
  ]);
  const totalSpend = sum(spend.map((r) => r.cost));
  const totalLines = sum([...linesOf.values()].map((n) => n ?? 0));
  return [...names]
    .map((key) => {
      const row = byName.get(key);
      const lines = linesOf.get(key) ?? null;
      const cost = row?.cost ?? 0;
      const hours = hoursOf.get(key) ?? 0;
      return {
        key,
        label: key,
        slot: row?.slot ?? -1,
        tone: null,
        spend: cost,
        lines,
        perK: lines !== null && lines > 0 ? (cost / lines) * 1000 : null,
        hours,
        hoursPerK: lines !== null && lines > 0 ? (hours / lines) * 1000 : null,
        shareSpend: totalSpend > 0 ? cost / totalSpend : 0,
        shareLines: lines !== null && totalLines > 0 ? lines / totalLines : null,
      };
    })
    .sort(
      (a, b) => b.spend - a.spend || (b.lines ?? 0) - (a.lines ?? 0) || (a.key < b.key ? -1 : 1),
    );
}

export function codeAnswer(answerer: Answerer, git: LinesSource, params: CodeParams): CodeAnswer {
  const tzMs = params.tz * 60_000;
  const asked = { ...params, metric: "cost" as const, split: "repo" as const, filters: {} };
  const spend = answerer.spend({ ...asked, top: 1_000_000 });
  const { buckets, bucket, to } = spend;
  const start = buckets[0] ?? spend.from;
  const count = buckets.length;
  const commits = new Map(git.names().map((name) => [name, git.lines(name) ?? []]));
  const stretchLines = new Map<string, number | null>();
  const entries = new Map<string, Entry>();
  const entryOf = (name: string, slot: number, tone: string | null): Entry => {
    const known = entries.get(name);
    if (known !== undefined) return known;
    const entry: Entry = {
      name,
      slot,
      tone,
      cost: new Array<number>(count).fill(0),
      lines: new Array<number>(count).fill(0),
      hours: new Array<number>(count).fill(0),
    };
    entries.set(name, entry);
    return entry;
  };
  for (const s of spend.series) entryOf(s.key, s.slot, s.tone).cost = s.values;
  for (const row of spend.rows) stretchLines.set(row.key, null);
  const stretchHours = new Map<string, number>();
  for (const [name, values] of answerer.activeHours(start, bucket, count)) {
    stretchHours.set(name, sum(values));
    if (sum(values) > 0) entryOf(name, -1, null).hours = values;
  }
  for (const [name, list] of commits) {
    const values = bucketLines(list, start, to, bucket, count, tzMs);
    stretchLines.set(name, sum(values));
    if (sum(values) > 0) {
      const entry = entryOf(name, -1, null);
      entry.lines = values;
    }
  }
  const chosen = [...entries.values()].filter(
    (e) => params.repo === null || e.name === params.repo,
  );
  const label = params.repo ?? "All repositories";
  const charts = chartSeries(chosen, params.byRepo, params.top, label, count);
  const checkedOut = chosen.filter((e) => git.lines(e.name) !== null);
  const ratios = perKSeries(checkedOut, bucket, count, params.top, label);
  // The same trailing window and minimum of lines, with hours where the dollars were.
  const hoursPerK = perKSeries(
    checkedOut.map((e) => ({ ...e, cost: e.hours })),
    bucket,
    count,
    0,
    label,
  ).perK;
  const rows = rowsOf(spend.rows, stretchLines, stretchHours);
  const shown = rows.filter((r) => params.repo === null || r.key === params.repo);
  const counted = shown.filter((r) => r.lines !== null);
  const lines = sum(counted.map((r) => r.lines ?? 0));
  const countedSpend = sum(counted.map((r) => r.spend));
  const countedHours = sum(counted.map((r) => r.hours));
  return {
    from: spend.from,
    to,
    bucket,
    buckets,
    repo: params.repo,
    byRepo: params.byRepo,
    repos: [...new Set([...answerer.values("repo"), ...git.names()])],
    ...charts,
    ...ratios,
    hoursPerK,
    totals: {
      spend: sum(shown.map((r) => r.spend)),
      lines,
      perK: lines > 0 ? (countedSpend / lines) * 1000 : null,
      hours: sum(shown.map((r) => r.hours)),
      hoursPerK: lines > 0 ? (countedHours / lines) * 1000 : null,
    },
    rows,
    ready: git.ready(),
  };
}
