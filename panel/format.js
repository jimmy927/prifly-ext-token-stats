// Numbers, times and colours, as the page shows them.

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export const SLOTS = 8;

/** 1.2M, 34.5k, 812. */
export function fmt(n) {
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(abs >= 1e8 ? 0 : 1)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(abs >= 1e5 ? 0 : 1)}k`;
  return String(Math.round(n));
}

/** $12.34, $1.2k, $3.4M. */
export function usd(n) {
  const abs = Math.abs(n);
  if (abs >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `$${(n / 1e3).toFixed(abs >= 1e5 ? 0 : 1)}k`;
  if (abs >= 100) return `$${Math.round(n)}`;
  return `$${n.toFixed(2)}`;
}

let dollars = false;

/** Whether the measure shown is the cost: `val` then writes dollars. */
export function measureIsCost(on) {
  dollars = on;
}

/** A value of the measure shown: dollars for the cost, a count otherwise. */
export const val = (n) => (dollars ? usd(n) : fmt(n));

/** "5 min", "3 h", "1 day". */
export function widthName(ms) {
  if (ms < MIN) return `${Math.round(ms / SEC)} s`;
  if (ms < HOUR) return `${Math.round(ms / MIN)} min`;
  if (ms < DAY) return `${Math.round(ms / HOUR)} h`;
  if (ms === 7 * DAY) return "1 week";
  return ms === DAY ? "1 day" : `${Math.round(ms / DAY)} days`;
}

const dayFmt = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  day: "numeric",
  month: "short",
});
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });
const secondsFmt = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});
const dateFmt = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });
const longFmt = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

/** A bucket's own name in a tooltip: its start, and its end when that says more. */
export function bucketName(start, width) {
  if (width >= DAY) {
    const end = new Date(start + width - 1);
    return width === DAY ? dayFmt.format(start) : `${dayFmt.format(start)} – ${dayFmt.format(end)}`;
  }
  const clock = width < MIN ? secondsFmt : timeFmt;
  return `${dayFmt.format(start)} ${clock.format(start)}–${clock.format(start + width)}`;
}

export function rangeName(from, to) {
  return `${longFmt.format(from)} – ${longFmt.format(to)}`;
}

const STEPS = [
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
  2 * DAY,
  7 * DAY,
  14 * DAY,
  30 * DAY,
];

/** Ticks at round local times, about one per `px` pixels. */
export function timeTicks(from, to, width, px = 110) {
  const want = Math.max(2, Math.floor(width / px));
  const step = STEPS.find((s) => (to - from) / s <= want) ?? 30 * DAY;
  const tz = -new Date(from).getTimezoneOffset() * MIN;
  const anchor = step === 7 * DAY || step === 14 * DAY ? 4 * DAY : 0;
  let t = Math.ceil((from + tz - anchor) / step) * step + anchor - tz;
  const out = [];
  for (; t <= to; t += step) out.push({ t, label: tickLabel(t, step) });
  return out;
}

function tickLabel(t, step) {
  const d = new Date(t);
  if (step >= DAY) return dateFmt.format(d);
  const midnight = d.getHours() === 0 && d.getMinutes() === 0 && d.getSeconds() === 0;
  if (midnight) return dateFmt.format(d);
  return step < MIN ? secondsFmt.format(d) : timeFmt.format(d);
}

/** A round top for the y axis. */
export function niceMax(v) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].map((m) => m * p).find((x) => x >= v) ?? v;
}

/** A model's family shade (`--m-opus-0`), the one colour a series or row has of its own. */
export const toneColour = (tone) => `var(--m-${tone})`;

/**
 * The colour of each series: a model's family shade when it has one, else its
 * all-time slot when that is one of the eight, otherwise the first slot no
 * other series on screen has, and grey for the rest.
 */
export function colours(series) {
  const slotted = series.filter((s) => s.tone == null);
  const taken = new Set(slotted.filter((s) => s.slot >= 0 && s.slot < SLOTS).map((s) => s.slot));
  const free = [...Array(SLOTS).keys()].filter((k) => !taken.has(k));
  return series.map((s) => {
    if (s.tone != null) return toneColour(s.tone);
    if (s.slot >= 0 && s.slot < SLOTS) return `var(--s${s.slot})`;
    if (s.slot >= SLOTS && free.length > 0) return `var(--s${free.shift()})`;
    return "var(--other)";
  });
}

const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/**
 * Hover-card rows by label, ignoring case, numbers read as numbers:
 * claude-opus-4-8, claude-opus-5, claude-opus-5-5. Rows marked `last` (the
 * chart's "N more") stay at the end.
 */
export function alphabetical(rows) {
  return [...rows].sort(
    (a, b) => Number(a.last === true) - Number(b.last === true) || byName.compare(a.label, b.label),
  );
}

export const esc = (s) =>
  String(s).replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
  );
