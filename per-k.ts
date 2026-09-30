/**
 * Dollars per 1,000 lines of code over time, for the Code view.
 *
 * Spend is spread over the hours a session runs, lines land in lumps when a
 * branch reaches the default one, so one hour's ratio swings from nothing to
 * thousands of dollars. Each point is therefore the spend and the lines of a
 * trailing day (or of its own bucket, when a bucket is a day or longer), and a
 * point whose day added fewer than `MIN_LINES` lines is left out as a gap
 * rather than drawn as a spike.
 *
 * The active hours per 1,000 lines are the same arithmetic with the reader's
 * hours in place of the dollars (`code-answer.ts`).
 */

const DAY = 24 * 3_600_000;

/** Fewer lines than this in a window say nothing about what a line costs. */
export const MIN_LINES = 100;

/** A line of the chart: a value per bucket, `null` where there is too little to tell. */
export type RatioSeries = {
  key: string;
  label: string;
  slot: number;
  tone: string | null;
  values: (number | null)[];
  /** The whole stretch's dollars per 1,000 lines; null without lines. */
  total: number | null;
};

/** How many buckets a point looks back over: a day's worth, at least its own. */
export const windowOf = (bucket: number) => Math.max(1, Math.round(DAY / bucket));

const sum = (values: readonly number[]) => values.reduce((a, b) => a + b, 0);

/** Each bucket's trailing-window spend over its lines, per 1,000 lines. */
export function trailingPerK(
  cost: readonly number[],
  lines: readonly number[],
  bucket: number,
): (number | null)[] {
  const width = windowOf(bucket);
  let spent = 0;
  let added = 0;
  return cost.map((c, k) => {
    spent += c;
    added += lines[k] ?? 0;
    if (k >= width) {
      spent -= cost[k - width] ?? 0;
      added -= lines[k - width] ?? 0;
    }
    return added >= MIN_LINES ? (spent / added) * 1000 : null;
  });
}

export type RatioEntry = {
  name: string;
  slot: number;
  tone: string | null;
  cost: readonly number[];
  lines: readonly number[];
};

function ratioOf(key: string, label: string, entry: RatioEntry, bucket: number): RatioSeries {
  const lines = sum(entry.lines);
  return {
    key,
    label,
    slot: entry.slot,
    tone: entry.tone,
    values: trailingPerK(entry.cost, entry.lines, bucket),
    total: lines > 0 ? (sum(entry.cost) / lines) * 1000 : null,
  };
}

/**
 * One line for all `entries` together, and one to each of the `top` with the
 * most spend that added lines. Only repositories with a checkout here belong
 * in `entries`: spend with no lines to count would only raise the price.
 */
export function perKSeries(
  entries: readonly RatioEntry[],
  bucket: number,
  count: number,
  top: number,
  label: string,
) {
  const together: RatioEntry = {
    name: "all",
    slot: 0,
    tone: null,
    cost: new Array<number>(count).fill(0),
    lines: new Array<number>(count).fill(0),
  };
  const cost = together.cost as number[];
  const lines = together.lines as number[];
  for (const e of entries) {
    for (let k = 0; k < count; k++) {
      cost[k] = (cost[k] ?? 0) + (e.cost[k] ?? 0);
      lines[k] = (lines[k] ?? 0) + (e.lines[k] ?? 0);
    }
  }
  const byRepo = entries
    .filter((e) => sum(e.lines) >= MIN_LINES)
    .sort((a, b) => sum(b.cost) - sum(a.cost) || (a.name < b.name ? -1 : 1))
    .slice(0, top)
    .map((e) => ratioOf(e.name, e.name, e, bucket));
  return { perK: ratioOf("all", label, together, bucket), perKByRepo: byRepo };
}
