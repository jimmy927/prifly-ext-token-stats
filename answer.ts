/**
 * The window's one question, answered whole: the chart's buckets and
 * series, the overview under it, the table, the weekday-by-hour map and the
 * values each filter can take.
 */

import {
  autoBucket,
  colourSlots,
  filtered,
  floorTo,
  labelOf,
  METRICS,
  type Metric,
  metricOf,
  type QueryParams,
} from "./query";
import { type Simulation, simulateRows } from "./simulate";
import { type Columns, DIMENSIONS, type Dimension } from "./store";
import { modelTones } from "./tones";

const DAY = 86_400_000;

/** `tone` is a model's family shade (`opus-0`), which the page prefers to the slot; see `tones.ts`. */
export type Series = {
  key: string;
  label: string;
  slot: number;
  tone: string | null;
  values: number[];
  total: number;
};
export type Row = {
  key: string;
  label: string;
  slot: number;
  tone: string | null;
  /** Dollars at API list prices, unpriced models' calls left out. */
  cost: number;
  output: number;
  input: number;
  cacheRead: number;
  calls: number;
  sessions: number;
};

export type Answer = {
  from: number;
  to: number;
  bucket: number;
  buckets: number[];
  series: Series[];
  overview: { bucket: number; buckets: number[]; values: number[] };
  rows: Row[];
  heat: number[][];
  facets: Record<Dimension, { key: string; label: string; total: number }[]>;
  span: { min: number; max: number };
  /** Calls in the shown stretch on a model with no price: not in any cost. */
  unpriced: { calls: number; models: string[] };
  /** The filtered calls' cost under smaller context windows: today (the reader's day) and the stretch. */
  simulation: { today: Simulation; stretch: Simulation };
};

const OTHER_SLOT = -1;
const MAX_BUCKETS = 1500;

export class Answerer {
  private readonly slots: Record<Dimension, Int32Array>;
  private readonly tones: (string | null)[];
  private readonly span: { min: number; max: number };
  private readonly facetCache = new Map<Metric, Answer["facets"]>();
  private readonly cols: Columns;

  constructor(cols: Columns) {
    this.cols = cols;
    this.slots = colourSlots(cols);
    this.tones = modelTones(cols.names.model);
    let min = Number.POSITIVE_INFINITY;
    let max = 0;
    for (const ts of cols.ts) {
      if (ts < min) min = ts;
      if (ts > max) max = ts;
    }
    this.span =
      cols.length === 0 ? { min: Date.now() - 86_400_000, max: Date.now() } : { min, max };
  }

  answer(params: QueryParams, now = Date.now()): Answer {
    const rows = filtered(this.cols, params.filters);
    const tzMs = params.tz * 60_000;
    // Nothing before the first call: "all time" starts there, not in 1970.
    const from = Math.max(params.from, this.span.min);
    const to = Math.max(params.to, from + 30_000);
    const span = to - from;
    // A bucket the reader chose, unless it would draw more bars than there are pixels.
    const bucket =
      params.bucket > 0 && span / params.bucket <= MAX_BUCKETS
        ? params.bucket
        : autoBucket(span, params.bucket > 0 ? MAX_BUCKETS : 240);
    const start = floorTo(from, bucket, tzMs);
    const buckets: number[] = [];
    for (let t = start; t < to; t += bucket) buckets.push(t);
    const inRange = rows.filter((i) => {
      const ts = this.cols.ts[i] ?? 0;
      return ts >= start && ts < to;
    });
    return {
      from,
      to,
      bucket,
      buckets,
      series: this.series(inRange, params, bucket, buckets, tzMs),
      overview: this.overview(rows, params.metric, tzMs),
      rows: this.table(inRange, params.split),
      heat: this.heat(inRange, params.metric, tzMs),
      facets: this.facets(params.metric),
      span: this.span,
      unpriced: this.unpriced(inRange),
      simulation: {
        today: simulateRows(this.cols, rows, floorTo(now, DAY, tzMs), now + 1),
        // From the first bucket's start, as the chart and the table count it.
        stretch: simulateRows(this.cols, inRange, start, to),
      },
    };
  }

  private unpriced(inRange: Int32Array): Answer["unpriced"] {
    const models = new Set<number>();
    let calls = 0;
    for (const i of inRange) {
      if (this.cols.priced[i] === 1) continue;
      calls += 1;
      models.add(this.cols.codes.model[i] ?? 0);
    }
    return { calls, models: [...models].map((code) => this.cols.names.model[code] ?? "?").sort() };
  }

  private codeOf(split: Dimension | "none", i: number): number {
    return split === "none" ? 0 : (this.cols.codes[split][i] ?? 0);
  }

  private slotOf(split: Dimension | "none", code: number): number {
    return split === "none" ? 0 : (this.slots[split][code] ?? 0);
  }

  private toneOf(split: Dimension | "none", code: number): string | null {
    return split === "model" ? (this.tones[code] ?? null) : null;
  }

  /** Each value's buckets, in the shown stretch. */
  private bucketed(
    inRange: Int32Array,
    params: QueryParams,
    width: number,
    buckets: number[],
    tzMs: number,
  ) {
    const first = buckets[0] ?? 0;
    const byCode = new Map<number, Float64Array>();
    for (const i of inRange) {
      const code = this.codeOf(params.split, i);
      let values = byCode.get(code);
      if (values === undefined) {
        values = new Float64Array(buckets.length);
        byCode.set(code, values);
      }
      const at = Math.floor((floorTo(this.cols.ts[i] ?? 0, width, tzMs) - first) / width);
      if (at >= 0 && at < buckets.length) {
        values[at] = (values[at] ?? 0) + metricOf(this.cols, params.metric, i);
      }
    }
    return [...byCode]
      .map(([code, values]) => ({ code, values, total: values.reduce((a, b) => a + b, 0) }))
      .filter((entry) => entry.total > 0)
      .sort((a, b) => b.total - a.total);
  }

  /** The biggest `top` values as lines of their own, and the rest as one. */
  private series(
    inRange: Int32Array,
    params: QueryParams,
    width: number,
    buckets: number[],
    tzMs: number,
  ): Series[] {
    const { split } = params;
    const ranked = this.bucketed(inRange, params, width, buckets, tzMs);
    const shown = ranked.slice(0, params.top).map(({ code, values, total }) => ({
      key: split === "none" ? "all" : (this.cols.names[split][code] ?? "?"),
      label: labelOf(this.cols, split, code),
      slot: this.slotOf(split, code),
      tone: this.toneOf(split, code),
      values: [...values],
      total,
    }));
    const rest = ranked.slice(params.top);
    if (rest.length === 0) return shown;
    const values = new Array<number>(buckets.length).fill(0);
    for (const entry of rest) {
      for (const [k, v] of entry.values.entries()) values[k] = (values[k] ?? 0) + v;
    }
    const total = values.reduce((a, b) => a + b, 0);
    return [
      ...shown,
      {
        key: "\u0000other",
        label: `${rest.length} more`,
        slot: OTHER_SLOT,
        tone: null,
        values,
        total,
      },
    ];
  }

  private overview(rows: Int32Array, metric: Metric, tzMs: number): Answer["overview"] {
    const bucket = autoBucket(this.span.max - this.span.min, 400);
    const first = floorTo(this.span.min, bucket, tzMs);
    const n = Math.floor((this.span.max - first) / bucket) + 1;
    const values = new Array<number>(n).fill(0);
    for (const i of rows) {
      const at = Math.floor(((this.cols.ts[i] ?? 0) - first) / bucket);
      if (at >= 0 && at < n) values[at] = (values[at] ?? 0) + metricOf(this.cols, metric, i);
    }
    return { bucket, buckets: values.map((_, k) => first + k * bucket), values };
  }

  private table(inRange: Int32Array, split: Dimension | "none"): Row[] {
    const rows = new Map<number, Row & { sessionSet: Set<number> }>();
    for (const i of inRange) {
      const code = this.codeOf(split, i);
      let row = rows.get(code);
      if (row === undefined) {
        row = {
          key: split === "none" ? "all" : (this.cols.names[split][code] ?? "?"),
          label: labelOf(this.cols, split, code),
          slot: this.slotOf(split, code),
          tone: this.toneOf(split, code),
          cost: 0,
          output: 0,
          input: 0,
          cacheRead: 0,
          calls: 0,
          sessions: 0,
          sessionSet: new Set(),
        };
        rows.set(code, row);
      }
      row.cost += this.cols.cost[i] ?? 0;
      row.output += this.cols.output[i] ?? 0;
      row.input += (this.cols.input[i] ?? 0) + (this.cols.cacheWrite[i] ?? 0);
      row.cacheRead += this.cols.cacheRead[i] ?? 0;
      row.calls += 1;
      row.sessionSet.add(this.cols.codes.session[i] ?? 0);
    }
    return [...rows.values()]
      .map(({ sessionSet, ...row }) => ({ ...row, sessions: sessionSet.size }))
      .sort((a, b) => b.cost - a.cost || b.output - a.output);
  }

  /** Seven rows, Monday first, of 24 hours each. */
  private heat(inRange: Int32Array, metric: Metric, tzMs: number): number[][] {
    const grid = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
    for (const i of inRange) {
      const local = new Date((this.cols.ts[i] ?? 0) + tzMs);
      const row = grid[(local.getUTCDay() + 6) % 7];
      const hour = local.getUTCHours();
      if (row !== undefined) row[hour] = (row[hour] ?? 0) + metricOf(this.cols, metric, i);
    }
    return grid;
  }

  private facets(metric: Metric): Answer["facets"] {
    const known = this.facetCache.get(metric);
    if (known !== undefined) return known;
    const facets = Object.fromEntries(
      DIMENSIONS.map((dim) => {
        const totals = new Float64Array(this.cols.names[dim].length);
        const codes = this.cols.codes[dim];
        for (let i = 0; i < this.cols.length; i++) {
          const code = codes[i] ?? 0;
          totals[code] = (totals[code] ?? 0) + metricOf(this.cols, metric, i);
        }
        const list = [...totals.keys()]
          .map((code) => ({
            key: this.cols.names[dim][code] ?? "?",
            label: labelOf(this.cols, dim, code),
            total: totals[code] ?? 0,
          }))
          .sort((a, b) => b.total - a.total)
          .slice(0, 300);
        return [dim, list];
      }),
    ) as Answer["facets"];
    this.facetCache.set(metric, facets);
    return facets;
  }
}

/** The query string as the window sends it, checked; bad values fall to the defaults. */
export function readParams(query: Record<string, string>, now: number): QueryParams {
  const num = (key: string, fallback: number) => {
    const value = Number(query[key]);
    return query[key] !== undefined && Number.isFinite(value) ? value : fallback;
  };
  const to = num("to", now);
  const split = query["split"];
  const metric = METRICS.find((m) => m === query["metric"]) ?? "cost";
  const filters: QueryParams["filters"] = {};
  try {
    const parsed: unknown = JSON.parse(query["filters"] ?? "{}");
    for (const dim of DIMENSIONS) {
      const values: unknown = (parsed as Record<string, unknown> | null)?.[dim];
      if (Array.isArray(values))
        filters[dim] = values.filter((v): v is string => typeof v === "string");
    }
  } catch {
    // An unreadable filter is no filter.
  }
  return {
    from: num("from", to - 7 * 86_400_000),
    to,
    bucket: num("bucket", 0),
    tz: num("tz", 0),
    split: DIMENSIONS.find((d) => d === split) ?? (split === "none" ? "none" : "account"),
    metric,
    filters,
    top: Math.max(1, Math.min(20, num("top", 8))),
  };
}
