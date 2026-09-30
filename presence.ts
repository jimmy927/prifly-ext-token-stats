/**
 * How long the reader was in front of Claude Code, for the Code view's
 * active time: estimated from the moments a person demonstrably acted in a
 * transcript (`HumanEvent`, read by `parse.ts`) — a typed prompt, a slash
 * command, an interrupt, an answer to a question, a refused tool call, a
 * prompt queued while Claude worked.
 *
 * Every session's events go on one timeline, sorted together: the reader
 * is one person, switching between sessions. Then
 *
 * - each event is preceded by its **lead**, the time since its session's
 *   previous assistant line, at most `LEAD_MAX`: reading the answer and
 *   typing the reply, counted as present;
 * - the rest of the stretch between two consecutive events (of any
 *   sessions) counts at `gapWeight` of its length — how often the reader
 *   was really there in a gap that long;
 * - each present moment goes to the session of the next event, the one the
 *   reader replied to next, and so to that session's repository (`store.ts`).
 *
 * Measured against prifly's own activity log, the next event's session was
 * the right one for only 41% of the hours, but its repository was wrong for
 * only 8%: the page shows active time per repository and in total, never
 * per session.
 */

const MIN = 60_000;
const HOUR = 60 * MIN;

/** The most of an event's lead counted: reading the answer and typing, not the time away before. */
export const LEAD_MAX = 2 * MIN;

/**
 * How often the reader was really present in a gap between two consecutive
 * human events, by the gap's length: up to `upTo` ms, `weight` of it counts.
 * Longer than the last entry counts nothing.
 *
 * Fit on 28–30 Sep 2026 against prifly's own activity log of when its window
 * had the reader's attention (51.6 h, 30.8 h of it active). A hard cut —
 * every gap up to 10 minutes whole, longer ones not at all — gave 31.7 h
 * (precision 0.95, recall 0.98); this table is the same fit, smoothed.
 */
export const GAP_WEIGHTS: readonly (readonly [upTo: number, weight: number])[] = [
  [2 * MIN, 1.0],
  [5 * MIN, 0.97],
  [10 * MIN, 0.72],
  [15 * MIN, 0.32],
  [30 * MIN, 0.09],
  [60 * MIN, 0.03],
];

/** The part of a gap of `gap` ms between two human events the reader was present for. */
export function gapWeight(gap: number): number {
  for (const [upTo, weight] of GAP_WEIGHTS) if (gap <= upTo) return weight;
  return 0;
}

/** One human event on the merged timeline; `owner` names whom its present moments go to. */
export type TimelineEvent = { ts: number; lead: number; owner: number };

/** A stretch of the timeline present at `weight` (0 to 1), credited to `owner`. */
export type Stretch = { from: number; to: number; weight: number; owner: number };

/**
 * The present stretches of a timeline of events from any sessions, in any
 * order. Each stretch lies between two consecutive events and goes to the
 * later one's owner: its lead part at weight 1, the rest at the gap's weight.
 * Leads end at their events, so within one gap the leads that reach into it
 * — its own event's, or a later one's that reaches further back — cover one
 * piece ending at the gap's end: the earliest start among them.
 */
export function presenceStretches(events: readonly TimelineEvent[]): Stretch[] {
  const sorted = [...events].sort((a, b) => a.ts - b.ts);
  const out: Stretch[] = [];
  let leadFrom = Number.POSITIVE_INFINITY;
  for (let i = sorted.length - 1; i >= 0; i--) {
    const event = sorted[i];
    if (event === undefined) continue;
    leadFrom = Math.min(leadFrom, event.ts - Math.min(Math.max(event.lead, 0), LEAD_MAX));
    const previous = sorted[i - 1]?.ts ?? Number.NEGATIVE_INFINITY;
    const covered = Math.max(leadFrom, previous);
    const { owner } = event;
    if (covered < event.ts) out.push({ from: covered, to: event.ts, weight: 1, owner });
    const weight = gapWeight(event.ts - previous);
    if (weight > 0 && previous < covered) out.push({ from: previous, to: covered, weight, owner });
  }
  return out.reverse();
}

/**
 * Add the hours of [from, to), times `weight`, into `values`, bucket `k`
 * being [start + k·width, start + (k+1)·width); what falls outside the
 * buckets is left out.
 */
export function spreadHours(
  values: number[],
  start: number,
  width: number,
  from: number,
  to: number,
  weight: number,
): void {
  const end = Math.min(to, start + values.length * width);
  let t = Math.max(from, start);
  while (t < end) {
    const k = Math.floor((t - start) / width);
    const next = Math.min(end, start + (k + 1) * width);
    values[k] = (values[k] ?? 0) + ((next - t) * weight) / HOUR;
    t = next;
  }
}
