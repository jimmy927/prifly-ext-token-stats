/**
 * What the calls would have cost with a smaller context window: an estimate,
 * and an upper bound on the saving.
 *
 * A call's context is everything it sent: `C = input + cacheWrite +
 * cacheRead`. Under a window `W < C` the conversation would have been
 * compacted before this call, so it carries at most `W` tokens. The excess
 * `C − W` comes off the cache reads first, then the cache writes (their
 * 5-minute part first), then the input; output is unchanged. A call with
 * `C ≤ W` is unchanged. The reduced counts are priced with `prices.ts`, as
 * every other cost on the page.
 *
 * Not modelled: the compaction calls themselves, the extra turns a smaller
 * window might need, and any change in quality. So the saving shown is the
 * most a smaller window could save, never less than it would.
 */

import type { Usage } from "./parse";
import { costOf, type Price, priceOf } from "./prices";
import type { Columns } from "./store";

/** The windows the page offers besides the one the calls ran with. */
export const WINDOWS = [800_000, 600_000, 400_000, 200_000] as const;

type Counts = Pick<Usage, "input" | "cacheWrite" | "cacheWrite1h" | "cacheRead" | "output">;

/** One call's counts as they would have been under a window of `window` tokens. */
export function clip(u: Counts, window: number): Counts {
  const context = u.input + u.cacheWrite + u.cacheRead;
  if (context <= window) return u;
  let excess = context - window;
  const fromRead = Math.min(excess, u.cacheRead);
  excess -= fromRead;
  const fromWrite = Math.min(excess, u.cacheWrite);
  excess -= fromWrite;
  const cacheWrite = u.cacheWrite - fromWrite;
  return {
    input: u.input - Math.min(excess, u.input),
    cacheWrite,
    cacheWrite1h: Math.min(u.cacheWrite1h ?? 0, cacheWrite),
    cacheRead: u.cacheRead - fromRead,
    output: u.output,
  };
}

/** One window's answer: its cost, and how many calls it would have cut. */
export type WindowCost = { window: number; cost: number; clipped: number };

export type Simulation = {
  from: number;
  to: number;
  /** What the priced calls cost as they ran. */
  actual: number;
  calls: number;
  /** The largest context any priced call carried. */
  largest: number;
  windows: WindowCost[];
  /** Calls on a model with no price: in no cost, here or anywhere. */
  unpriced: number;
};

/** A running total over calls, one slot per window. */
class Tally {
  actual = 0;
  calls = 0;
  largest = 0;
  unpriced = 0;
  readonly windows: readonly number[];
  readonly costs: number[];
  readonly clipped: number[];

  constructor(windows: readonly number[]) {
    this.windows = windows;
    this.costs = windows.map(() => 0);
    this.clipped = windows.map(() => 0);
  }

  /** A whole call's counts `u`, of which `share` is counted: a call split across repositories. */
  add(price: Price | null, u: Counts, share = 1): void {
    if (price === null) {
      this.unpriced += share;
      return;
    }
    const context = u.input + u.cacheWrite + u.cacheRead;
    this.calls += share;
    this.actual += costOf(price, u) * share;
    if (context > this.largest) this.largest = context;
    for (const [k, window] of this.windows.entries()) {
      this.costs[k] = (this.costs[k] ?? 0) + costOf(price, clip(u, window)) * share;
      if (context > window) this.clipped[k] = (this.clipped[k] ?? 0) + share;
    }
  }

  result(from: number, to: number): Simulation {
    const { actual, calls, largest, unpriced } = this;
    const windows = this.windows.map((window, k) => ({
      window,
      cost: this.costs[k] ?? 0,
      clipped: this.clipped[k] ?? 0,
    }));
    return { from, to, actual, calls, largest, windows, unpriced };
  }
}

/** The calls in `usages` under each window, priced by their own models. */
export function simulateWindow(
  usages: Iterable<Usage>,
  windows: readonly number[] = WINDOWS,
  from = 0,
  to = 0,
): Simulation {
  const tally = new Tally(windows);
  const prices = new Map<string, Price | null>();
  for (const u of usages) {
    if (!prices.has(u.model)) prices.set(u.model, priceOf(u.model));
    tally.add(prices.get(u.model) ?? null, u);
  }
  return tally.result(from, to);
}

/** The same over the store's rows `rows` that fall in `[from, to)`. */
export function simulateRows(
  cols: Columns,
  rows: Int32Array,
  from: number,
  to: number,
  windows: readonly number[] = WINDOWS,
): Simulation {
  const tally = new Tally(windows);
  for (const i of rows) {
    const ts = cols.ts[i] ?? 0;
    if (ts < from || ts >= to) continue;
    // A part of a split call is cut as the whole call would be: the window sees all its context.
    const share = cols.share[i] ?? 1;
    tally.add(
      cols.prices[cols.codes.model[i] ?? 0] ?? null,
      {
        input: (cols.input[i] ?? 0) / share,
        cacheWrite: (cols.cacheWrite[i] ?? 0) / share,
        cacheWrite1h: (cols.cacheWrite1h[i] ?? 0) / share,
        cacheRead: (cols.cacheRead[i] ?? 0) / share,
        output: (cols.output[i] ?? 0) / share,
      },
      share,
    );
  }
  return tally.result(from, to);
}
