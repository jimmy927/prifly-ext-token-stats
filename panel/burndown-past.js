// The burn-down's past before the readings (`past.ts`): each window's %
// reconstructed from its ends, or estimated from its cost with a band, and
// the pool's sum of them. Drawn as % left, like the rest of the chart.

import { el } from "./chart.js";

/** An account's weekly % used as the % it has left. */
export const left = (points) => points.map(([t, v]) => [t, 100 - v]);

/** `points` from `from` on, the one crossing it cut there. */
function clip(points, from) {
  const k = points.findIndex(([t]) => t >= from);
  if (k <= 0) return k === 0 ? points : [];
  const [t0, v0] = points[k - 1];
  const [t1, v1] = points[k];
  return [[from, v0 + ((from - t0) / (t1 - t0)) * (v1 - v0)], ...points.slice(k)];
}

export const pathOf = (f, points) =>
  points
    .map(([t, v], k) => `${k === 0 ? "M" : "L"}${f.x(t).toFixed(1)} ${f.y(v).toFixed(1)}`)
    .join("");

/** The two strokes set apart from the measured (solid) and forecast (dashed 5 4) lines. */
export const STYLES = {
  reconstructed: { "stroke-width": 1.5, "stroke-dasharray": "1 3", "stroke-linecap": "round" },
  estimated: { "stroke-width": 1.5, "stroke-dasharray": "7 2 1 2" },
};

/** A past stretch in `kind`'s stroke: thin, dotted or dash-dotted. */
export function pastLine(svg, f, points, colour, kind) {
  const shown = clip(points, f.from);
  if (shown.length < 2) return;
  const attrs = { d: pathOf(f, shown), fill: "none", stroke: colour, class: kind };
  el("path", { ...attrs, ...STYLES[kind] }, svg);
}

/** A band between two lines of % left, [t, low, high] a point, faintly filled. */
export function bandArea(svg, f, band, colour) {
  const lows = clip(
    band.map(([t, lo]) => [t, lo]),
    f.from,
  );
  const highs = clip(
    band.map(([t, , hi]) => [t, hi]),
    f.from,
  );
  if (lows.length < 2) return;
  const d = `${pathOf(f, highs)}${pathOf(f, [...lows].reverse()).replace(/^M/, "L")}Z`;
  el("path", { d, fill: colour, class: "band" }, svg);
}

/** An estimated window of an account: its band and its dash-dotted line, in % left. */
export function estimatedCurve(svg, f, c, colour) {
  bandArea(
    svg,
    f,
    c.band.map(([t, lo, hi]) => [t, 100 - hi, 100 - lo]),
    colour,
  );
  pastLine(svg, f, left(c.points), colour, "estimated");
}

/** One pool run: the band and dash-dotted line where a share is estimated, dotted where every one is reconstructed. */
export function poolRun(svg, f, run, colour) {
  const band = run.points.map(([t], k) => [t, ...run.range[k]]);
  const n = run.points.length;
  // Segment j joins points j and j + 1; a run of segments of one kind is drawn at once.
  const kind = (j) => (run.estimated[j] && run.estimated[j + 1] ? "estimated" : "reconstructed");
  let start = 0;
  for (let j = 1; j < n; j++) {
    if (j < n - 1 && kind(j) === kind(start)) continue;
    if (kind(start) === "estimated") bandArea(svg, f, band.slice(start, j + 1), colour);
    pastLine(svg, f, run.points.slice(start, j + 1), colour, kind(start));
    start = j;
  }
}

/** Whether `answer` has any estimated window, and the band's words for the hover. */
export const hasEstimate = (answer) => answer.past.curves.some((c) => c.anchor === "estimate");
export const bandWords = (answer) =>
  `estimated ±${Math.round(answer.past.band * 100)}% (leave-one-out error 29% RMS)`;
