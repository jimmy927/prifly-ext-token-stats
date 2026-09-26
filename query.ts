/**
 * What the window asks: a stretch of time, cut into buckets, one line per
 * value of the dimension it splits by, with the rest of the answer — the
 * whole timeline for the overview, a table, an hour-by-weekday map — about
 * the same filtered calls.
 */

import { type Columns, DIMENSIONS, type Dimension } from "./store";

export const METRICS = ["output", "input", "cacheRead", "all", "calls"] as const;
export type Metric = (typeof METRICS)[number];

export type Filters = Partial<Record<Dimension, string[]>>;

export type QueryParams = {
  from: number;
  to: number;
  /** Bucket width in ms; 0 picks one that gives about 200 buckets. */
  bucket: number;
  /** The reader's offset from UTC in minutes, so a day is their day. */
  tz: number;
  split: Dimension | "none";
  metric: Metric;
  filters: Filters;
  top: number;
};

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
export const BUCKETS = [
  SEC,
  5 * SEC,
  15 * SEC,
  30 * SEC,
  MIN,
  5 * MIN,
  15 * MIN,
  30 * MIN,
  HOUR,
  3 * HOUR,
  6 * HOUR,
  12 * HOUR,
  DAY,
  WEEK,
];

/** The narrowest bucket that keeps a span under `most` buckets. */
export function autoBucket(span: number, most = 240): number {
  return BUCKETS.find((width) => span / width <= most) ?? WEEK;
}

/** The start of the bucket `ts` falls in, in the reader's time: weeks start on Monday. */
export function floorTo(ts: number, width: number, tzMs: number): number {
  // 1970-01-05 was a Monday.
  const anchor = width === WEEK ? 4 * DAY : 0;
  return Math.floor((ts + tzMs - anchor) / width) * width + anchor - tzMs;
}

export function metricOf(cols: Columns, metric: Metric, i: number): number {
  switch (metric) {
    case "output":
      return cols.output[i] ?? 0;
    case "input":
      return (cols.input[i] ?? 0) + (cols.cacheWrite[i] ?? 0);
    case "cacheRead":
      return cols.cacheRead[i] ?? 0;
    case "all":
      return (
        (cols.input[i] ?? 0) +
        (cols.cacheWrite[i] ?? 0) +
        (cols.cacheRead[i] ?? 0) +
        (cols.output[i] ?? 0)
      );
    case "calls":
      return 1;
  }
}

/** The rows the filters let through, in any time. */
export function filtered(cols: Columns, filters: Filters): Int32Array {
  const wanted = DIMENSIONS.flatMap((dim) => {
    const values = filters[dim];
    if (values === undefined || values.length === 0) return [];
    const names = cols.names[dim];
    const codes = new Set(values.map((value) => names.indexOf(value)).filter((code) => code >= 0));
    return [{ codes: cols.codes[dim], allowed: codes }];
  });
  const out = new Int32Array(cols.length);
  let n = 0;
  for (let i = 0; i < cols.length; i++) {
    if (wanted.every(({ codes, allowed }) => allowed.has(codes[i] ?? -1))) out[n++] = i;
  }
  return out.subarray(0, n);
}

/**
 * A colour slot per value, by its all-time output: the same value keeps its
 * colour whatever is filtered, and the biggest get the first slots.
 */
export function colourSlots(cols: Columns): Record<Dimension, Int32Array> {
  return Object.fromEntries(DIMENSIONS.map((dim) => [dim, bySize(cols, dim)])) as Record<
    Dimension,
    Int32Array
  >;
}

function bySize(cols: Columns, dim: Dimension): Int32Array {
  const totals = new Float64Array(cols.names[dim].length);
  const codes = cols.codes[dim];
  for (let i = 0; i < cols.length; i++) {
    const code = codes[i] ?? 0;
    totals[code] = (totals[code] ?? 0) + (cols.output[i] ?? 0);
  }
  const order = [...totals.keys()].sort((a, b) => (totals[b] ?? 0) - (totals[a] ?? 0));
  const slots = new Int32Array(totals.length);
  order.forEach((code, rank) => {
    slots[code] = rank;
  });
  return slots;
}

/** A value as the window shows it: a session by its title. */
export function labelOf(cols: Columns, dim: Dimension | "none", code: number): string {
  if (dim === "none") return "All";
  const name = cols.names[dim][code] ?? "?";
  if (dim !== "session") return name;
  const title = cols.titles.get(name);
  return title === undefined ? name.slice(0, 8) : `${title} · ${name.slice(0, 8)}`;
}
