/**
 * What a call would have cost at Anthropic's API list prices, in US dollars.
 *
 * Source: https://platform.claude.com/docs/en/about-claude/pricing ("Model
 * pricing"), checked 2026-09-26. Prices are per million tokens: base input,
 * cache writes at the 5-minute and at the 1-hour rate, cache reads (hits and
 * refreshes) and output.
 *
 * Not modelled, because none of it is in the transcripts read so far or the
 * page has no such tier: long-context rates (Claude 4.6 and later bill the
 * whole 1M window at the standard rate; the page lists no long-context tier
 * for any model), fast mode (every call recorded `speed: "standard"`),
 * US-only inference (`inference_geo` is "not_available") and the batch
 * discount (Claude Code does not batch).
 *
 * A model missing from the table is unpriced: its calls are counted apart and
 * named, never costed at $0.
 */

import type { Usage } from "./parse";

export type Price = {
  input: number;
  write5m: number;
  write1h: number;
  read: number;
  output: number;
};

const p = (input: number, write5m: number, write1h: number, read: number, output: number) => ({
  input,
  write5m,
  write1h,
  read,
  output,
});

/** By model family: the id without a date or a `[1m]` suffix. */
const PRICES: Record<string, Price> = {
  "claude-fable-5-1": p(10, 12.5, 20, 0.25, 50),
  "claude-mythos-5-1": p(10, 12.5, 20, 0.25, 50),
  "claude-fable-5": p(10, 12.5, 20, 1, 50),
  "claude-mythos-5": p(10, 12.5, 20, 1, 50),
  "claude-opus-5-5": p(4, 5, 8, 0.2, 20),
  "claude-opus-5": p(5, 6.25, 10, 0.5, 25),
  "claude-opus-4-8": p(5, 6.25, 10, 0.5, 25),
  "claude-opus-4-7": p(5, 6.25, 10, 0.5, 25),
  "claude-opus-4-6": p(5, 6.25, 10, 0.5, 25),
  "claude-opus-4-5": p(5, 6.25, 10, 0.5, 25),
  "claude-opus-4-1": p(15, 18.75, 30, 1.5, 75),
  "claude-opus-4": p(15, 18.75, 30, 1.5, 75),
  "claude-sonnet-5": p(2, 2.5, 4, 0.2, 10),
  "claude-sonnet-4-6": p(3, 3.75, 6, 0.3, 15),
  "claude-sonnet-4-5": p(3, 3.75, 6, 0.3, 15),
  "claude-sonnet-4": p(3, 3.75, 6, 0.3, 15),
  "claude-haiku-4-5": p(1, 1.25, 2, 0.1, 5),
  "claude-3-5-haiku": p(0.8, 1, 1.6, 0.08, 4),
};

/**
 * The family a model id belongs to: `claude-haiku-4-5-20251001` is
 * `claude-haiku-4-5`, `claude-opus-5[1m]` is `claude-opus-5`, and a cloud
 * platform's `us.anthropic.claude-…-v1:0` is its `claude-…`.
 */
export function familyOf(model: string): string {
  const start = model.indexOf("claude-");
  return model
    .slice(Math.max(0, start))
    .replace(/\[[^\]]*\]$/, "")
    .replace(/-v\d+(:\d+)?$/, "")
    .replace(/[-@]\d{8}$/, "");
}

export function priceOf(model: string): Price | null {
  return PRICES[familyOf(model)] ?? null;
}

type Counts = Pick<Usage, "input" | "cacheWrite" | "cacheWrite1h" | "cacheRead" | "output">;

/**
 * One call's cost in dollars. Calls read before the 5-minute/1-hour split was
 * kept (archived transcripts, cached cloud sessions) have no `cacheWrite1h`:
 * all their cache writes are priced at the 5-minute rate, the lower bound.
 */
export function costOf(price: Price, u: Counts): number {
  const hour = Math.min(u.cacheWrite1h ?? 0, u.cacheWrite);
  return (
    (u.input * price.input +
      (u.cacheWrite - hour) * price.write5m +
      hour * price.write1h +
      u.cacheRead * price.read +
      u.output * price.output) /
    1e6
  );
}
