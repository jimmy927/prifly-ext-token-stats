// The Forecast view's burn-down: each account's weekly percent, three days
// measured and six days forecast at its 24 h burn, or what the whole pool
// has left; under it, each account's weekly windows and the minutes it hit
// its limit, 7 days back (`history.ts`). The numbers come from
// `forecast.ts`; this only draws them.

import { el } from "./chart.js";
import { clockName, dayName, esc } from "./format.js";
import { hideTip, showTip } from "./tip.js";

const M = { l: 56, r: 12, t: 16, b: 22 };
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const pct = (v) => `${Math.round(v)}%`;

/** The accounts the legend has hidden, and "accounts" or "pool" as last drawn. */
const view = { mode: "accounts", hidden: new Set() };

/** Local midnights from `from` to `to`: the time axis's ticks. */
function midnights(from, to) {
  const d = new Date(from);
  d.setHours(24, 0, 0, 0);
  const out = [];
  for (; d.getTime() <= to; d.setDate(d.getDate() + 1)) out.push(d.getTime());
  return out;
}

/** Height of one account's lane of weekly windows, under the axis. */
const LANE = 9;

/** Whether the chart reaches back for weekly windows: only when the transcripts named any. */
const reachesBack = (answer) => answer.history.windows.length > 0;

function frame(host, answer) {
  const width = Math.max(host.clientWidth, 300);
  const lanes = reachesBack(answer) ? answer.accounts.length * LANE + 6 : 0;
  const height = Math.max(host.clientHeight, 160 + lanes);
  const plotW = width - M.l - M.r;
  const plotH = height - M.t - M.b - lanes;
  const from = reachesBack(answer)
    ? Math.min(answer.history.from, answer.grid.from)
    : answer.grid.from;
  const to = answer.grid.from + (answer.grid.pool.length - 1) * answer.grid.step;
  const x = (t) => M.l + ((t - from) / (to - from)) * plotW;
  const top = view.mode === "pool" ? Math.max(1, answer.accounts.length) * 100 : 100;
  const y = (v) => M.t + plotH - (v / top) * plotH;
  return { width, height, plotW, plotH, lanes, from, to, x, y, top };
}

const when = (t) => `${dayName(t)} ${clockName(t)} CET`;

/**
 * Under the axis, one lane per account: its weekly windows from the
 * transcripts and its latest reading, a tick at each reset and a dot at the
 * minute it hit 100%, each with its own hover card.
 */
function drawLanes(svg, f, answer, colours) {
  if (f.lanes === 0) return;
  const base = M.t + f.plotH + M.b;
  el(
    "text",
    { x: M.l - 6, y: base + 8, "text-anchor": "end", class: "before-label" },
    svg,
  ).textContent = "weeks";
  answer.accounts.forEach((a, i) => {
    if (view.mode === "accounts" && view.hidden.has(a.email)) return;
    const y = base + i * LANE;
    const colour = colours[i];
    for (const w of answer.history.windows.filter((w) => w.email === a.email)) {
      const x1 = f.x(Math.max(w.start, f.from));
      const x2 = f.x(Math.min(w.end, f.to));
      if (x2 <= x1) continue;
      const rect = el(
        "rect",
        { x: x1, y, width: x2 - x1, height: LANE - 3, fill: colour, class: "lane" },
        svg,
      );
      rect.addEventListener("mousemove", (event) =>
        showTip(
          event,
          `${a.label} · weekly window`,
          [
            { label: "Began", value: w.start, colour },
            { label: "Resets", value: w.end, colour },
          ],
          ["Hit 100%", w.hitAt === null ? "no refusal in the transcripts" : when(w.hitAt)],
          when,
        ),
      );
      rect.addEventListener("mouseleave", hideTip);
      if (w.end <= f.to) {
        el(
          "line",
          { x1: x2, x2, y1: y - 1, y2: y + LANE - 2, stroke: colour, class: "lane-end" },
          svg,
        );
      }
      if (w.hitAt === null || w.hitAt < f.from) continue;
      const dot = el(
        "circle",
        { cx: f.x(w.hitAt), cy: y + (LANE - 3) / 2, r: 3.5, fill: colour, class: "hit" },
        svg,
      );
      dot.addEventListener("mousemove", (event) =>
        showTip(
          event,
          `${a.label} hit its weekly limit`,
          [{ label: "At", value: w.hitAt, colour }],
          ["Refused calls", `${w.refusals}, last ${when(w.lastRefusalAt)}`],
          when,
        ),
      );
      dot.addEventListener("mouseleave", hideTip);
    }
  });
}

/** The stretch before the first reading, hatched: no % is known there. */
function beforeReadings(svg, f, answer) {
  const until = Math.min(answer.firstAt ?? answer.now, answer.now);
  if (until <= f.from) return;
  const pattern = el(
    "pattern",
    {
      id: "fc-before",
      width: 6,
      height: 6,
      patternUnits: "userSpaceOnUse",
      patternTransform: "rotate(45)",
    },
    el("defs", {}, svg),
  );
  el("line", { x1: 0, x2: 0, y1: 0, y2: 6, stroke: "var(--border)", "stroke-width": 1 }, pattern);
  const width = f.x(until) - M.l;
  el("rect", { x: M.l, y: M.t, width, height: f.plotH, class: "before" }, svg);
  if (width < 150) return;
  const label = { x: M.l + width / 2, "text-anchor": "middle", class: "before-label halo" };
  el("text", { ...label, y: M.t + f.plotH / 2 - 4 }, svg).textContent = "no weekly % before";
  el("text", { ...label, y: M.t + f.plotH / 2 + 12 }, svg).textContent =
    `readings began ${dayName(until)} ${clockName(until)}`;
}

function axes(svg, f, answer) {
  const now = answer.now;
  el(
    "rect",
    { x: f.x(now), y: M.t, width: f.x(f.to) - f.x(now), height: f.plotH, class: "future" },
    svg,
  );
  beforeReadings(svg, f, answer);
  for (let k = 0; k <= 5; k++) {
    const v = (f.top * k) / 5;
    el("line", { x1: M.l, x2: f.width - M.r, y1: f.y(v), y2: f.y(v), class: "grid" }, svg);
    el("text", { x: M.l - 6, y: f.y(v) + 4, "text-anchor": "end" }, svg).textContent = `${v}%`;
  }
  let free = 0;
  for (const t of midnights(f.from, f.to)) {
    const px = f.x(t);
    el("line", { x1: px, x2: px, y1: M.t, y2: M.t + f.plotH, class: "grid" }, svg);
    if (px + 4 < free) continue;
    const label = el(
      "text",
      { x: px + 4, y: M.t + f.plotH + M.b - 6, "text-anchor": "start" },
      svg,
    );
    label.textContent = dayName(t);
    const end = px + 4 + label.getComputedTextLength();
    // A day too narrow for its name skips it; the last one's runs past the edge and goes rather than being cut.
    if (end > f.width) label.remove();
    else free = end + 8;
  }
  const base = M.t + f.plotH;
  el("line", { x1: M.l, x2: f.width - M.r, y1: base, y2: base, class: "axis" }, svg);
}

function line(svg, f, points, colour, dashed) {
  if (points.length < 2) return;
  const d = points
    .map(([t, v], k) => `${k === 0 ? "M" : "L"}${f.x(t).toFixed(1)} ${f.y(v).toFixed(1)}`)
    .join("");
  const attrs = { d, fill: "none", stroke: colour, "stroke-width": 2, "stroke-linejoin": "round" };
  if (dashed) attrs["stroke-dasharray"] = "5 4";
  el("path", attrs, svg);
}

/** A dot at each reading when they span too few pixels for a line: minutes on a nine-day axis. */
function dots(svg, f, points, colour, r = 3) {
  const first = points[0];
  const last = points.at(-1);
  if (first === undefined || f.x(last[0]) - f.x(first[0]) >= 12) return;
  for (const [t, v] of points) {
    el("circle", { cx: f.x(t), cy: f.y(v), r, fill: colour, stroke: "var(--card)" }, svg);
  }
}

function limit(svg, f, value, words) {
  el("line", { x1: M.l, x2: f.width - M.r, y1: f.y(value), y2: f.y(value), class: "limit" }, svg);
  const label = { x: f.width - M.r - 4, y: f.y(value) - 5, "text-anchor": "end" };
  el("text", { ...label, class: "limit-label halo" }, svg).textContent = words;
}

/** The pool's line, measured up to now and forecast after, and its hover rows at hour `k`. */
function drawPool(svg, f, answer, colours) {
  limit(svg, f, 0, "pool empty");
  line(svg, f, answer.pool.forecast, "var(--fg)", true);
  line(svg, f, answer.pool.measured, "var(--fg)", false);
  dots(svg, f, answer.pool.measured, "var(--fg)");
  return (k) => {
    const rows = answer.accounts
      .map((a, i) => ({ label: a.label, value: a.hourly[k], colour: colours[i] }))
      .filter((r) => r.value !== null)
      .map((r) => ({ ...r, value: 100 - r.value }));
    return { rows, total: ["Pool left", pct(rows.reduce((s, r) => s + r.value, 0))] };
  };
}

function drawAccounts(svg, f, answer, colours) {
  limit(svg, f, 100, "limit");
  const shown = answer.accounts
    .map((a, i) => ({ a, colour: colours[i] }))
    .filter(({ a }) => !view.hidden.has(a.email));
  for (const { a, colour } of shown) {
    line(svg, f, a.forecast, colour, true);
    line(svg, f, a.measured, colour, false);
  }
  // Dots over every line, the first account's largest: accounts read at the same % and minute show as rings.
  shown.forEach(({ a, colour }, k) => {
    dots(svg, f, a.measured, colour, 3 + 1.5 * (shown.length - 1 - k));
  });
  return (k) => ({
    rows: answer.accounts
      .map((a, i) => ({ label: a.label, value: a.hourly[k], colour: colours[i], email: a.email }))
      .filter((r) => r.value !== null && !view.hidden.has(r.email)),
    total: false,
  });
}

function nowLine(svg, f, answer) {
  const now = answer.now;
  el("line", { x1: f.x(now), x2: f.x(now), y1: M.t - 12, y2: M.t + f.plotH, class: "now" }, svg);
  const at = { y: M.t - 4 };
  el(
    "text",
    { ...at, x: f.x(now) + 4, "text-anchor": "start", class: "now-label halo" },
    svg,
  ).textContent = `now · ${clockName(now)} CET`;
  // Minutes of readings leave no room left of now for the word: it would cover the axis or the hatching.
  if (f.x(now) - f.x(Math.max(answer.firstAt ?? now, f.from)) >= 64)
    el("text", { ...at, x: f.x(now) - 4, "text-anchor": "end", class: "halo" }, svg).textContent =
      "measured";
  const ahead = el(
    "text",
    { ...at, x: f.x(now) + 124, "text-anchor": "start", class: "halo" },
    svg,
  );
  ahead.textContent = "forecast at each account's burn";
  // Seven days of weekly windows push now right: the words go rather than being cut.
  if (f.x(now) + 124 + ahead.getComputedTextLength() > f.width) ahead.remove();
}

/** The chart's subtitle: how much of it is measured, from the first reading or 3 days back. */
export function burndownSpan(answer) {
  const ms = answer.now - Math.max(answer.firstAt ?? answer.now, answer.grid.from);
  const span =
    ms < HOUR
      ? `${Math.round(ms / 60_000)} min`
      : ms < 2 * DAY
        ? `${Math.round(ms / HOUR)} h`
        : `${Math.round(ms / DAY)} days`;
  const back = reachesBack(answer) ? " · weekly windows 7 days back" : "";
  return `Weekly %, ${span} measured, 6 days ahead${back}`;
}

/** What the chart under it draws, in the mode on screen, and how far back the readings go. */
export function burndownNote(mode, answer) {
  const since =
    answer.firstAt >= answer.grid.from
      ? ` Readings began ${dayName(answer.firstAt)} ${clockName(answer.firstAt)} CET, where the ${reachesBack(answer) ? "% lines start" : "chart starts"}; while they span only minutes each is a dot, and accounts read at the same % and minute show as rings round one spot.`
      : "";
  const lines =
    mode === "pool"
      ? `What all ${answer.accounts.length} accounts have left together: the sum of 100 − each one's weekly %, so at most ${answer.accounts.length * 100}%. At an account's reset its share refills to 100 and it burns again at its rate; an account with no rate is held where it is.`
      : "Each line climbs at that account's burn, stops at the 100% limit and drops to 0 at its weekly reset. An account with no rate has no forecast line.";
  const unplaced = answer.history.unplaced;
  const past = reachesBack(answer)
    ? ` Under the axis each account's lane shows its weekly windows (a tick at each reset) and a dot at the minute Claude Code first refused a call for its weekly limit, from the transcripts. The hatching has no %: prifly keeps only each account's latest reading, so none exists before the readings.${unplaced > 0 ? ` ${unplaced} refusal${unplaced === 1 ? "" : "s"} in the last 7 days matched no account prifly holds.` : ""}`
    : "";
  return `${lines}${since}${past}`;
}

/** Crosshair and the shared hover card, hour by hour. */
function hover(svg, f, answer, rowsAt) {
  const layer = el(
    "rect",
    { x: M.l, y: M.t, width: f.plotW, height: f.plotH, fill: "transparent" },
    svg,
  );
  const cross = el(
    "line",
    { y1: M.t, y2: M.t + f.plotH, class: "cross", visibility: "hidden" },
    svg,
  );
  const { from, step, pool } = answer.grid;
  layer.addEventListener("mousemove", (event) => {
    const t = f.from + ((event.offsetX - M.l) / f.plotW) * (f.to - f.from);
    const k = Math.min(pool.length - 1, Math.max(0, Math.round((t - from) / step)));
    const at = from + k * step;
    const { rows, total } = rowsAt(k);
    // An hour before the first reading, or before the grid, has nothing to show, not a 0.
    if (rows.length === 0 || t < from - step / 2) {
      cross.setAttribute("visibility", "hidden");
      hideTip();
      return;
    }
    cross.setAttribute("x1", f.x(at));
    cross.setAttribute("x2", f.x(at));
    cross.setAttribute("visibility", "visible");
    const title = `${dayName(at)} ${clockName(at)} CET · ${at <= answer.now ? "measured" : "forecast"}`;
    showTip(event, title, rows, total, pct);
  });
  layer.addEventListener("mouseleave", () => {
    cross.setAttribute("visibility", "hidden");
    hideTip();
  });
}

function drawLegend(host, answer, colours, redraw) {
  const pool = view.mode === "pool";
  const accounts = pool
    ? `<span class="key"><i class="sw" style="background:var(--fg)"></i>Left in the pool, all ${answer.accounts.length} accounts</span>`
    : answer.accounts
        .map(
          (a, i) =>
            `<button type="button" data-k="${esc(a.email)}" aria-pressed="${!view.hidden.has(a.email)}" title="Click to hide or show"><i class="sw" style="background:${colours[i]}"></i><span>${esc(a.label)}</span></button>`,
        )
        .join("");
  const key = (dash) =>
    `<svg width="24" height="6"><line x1="0" x2="24" y1="3" y2="3" stroke="var(--muted-fg)" stroke-width="2"${dash ? ' stroke-dasharray="5 4"' : ""}/></svg>`;
  host.innerHTML = `<div class="legend">${accounts}</div><span class="grow"></span>
    <span class="key">${key(false)}measured</span><span class="key">${key(true)}forecast</span>`;
  for (const button of host.querySelectorAll("button[data-k]")) {
    button.addEventListener("click", () => {
      const k = button.dataset.k;
      if (view.hidden.has(k)) view.hidden.delete(k);
      else view.hidden.add(k);
      redraw();
    });
  }
}

/**
 * Draw the burn-down of `answer` into `host`, its legend into `legendHost`:
 * per account, or with `mode` "pool" what the whole pool has left.
 */
export function drawBurndown(host, legendHost, answer, colours, mode) {
  view.mode = mode;
  host.replaceChildren();
  const redraw = () => drawBurndown(host, legendHost, answer, colours, mode);
  drawLegend(legendHost, answer, colours, redraw);
  const f = frame(host, answer);
  const svg = el("svg", { width: f.width, height: f.height, role: "img" }, host);
  svg.setAttribute(
    "aria-label",
    view.mode === "pool" ? "What the pool has left over time" : "Each account's weekly % over time",
  );
  axes(svg, f, answer);
  const rowsAt =
    view.mode === "pool"
      ? drawPool(svg, f, answer, colours)
      : drawAccounts(svg, f, answer, colours);
  nowLine(svg, f, answer);
  hover(svg, f, answer, rowsAt);
  drawLanes(svg, f, answer, colours);
}
