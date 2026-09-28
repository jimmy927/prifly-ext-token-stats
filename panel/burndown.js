// The Forecast view's burn-down: each account's weekly percent, three days
// measured and six days forecast at its 24 h burn, or what the whole pool
// has left. The numbers come from `forecast.ts`; this only draws them.

import { el } from "./chart.js";
import { clockName, dayName, esc } from "./format.js";
import { hideTip, showTip } from "./tip.js";

const M = { l: 56, r: 12, t: 16, b: 22 };
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

function frame(host, answer) {
  const width = Math.max(host.clientWidth, 300);
  const height = Math.max(host.clientHeight, 160);
  const plotW = width - M.l - M.r;
  const plotH = height - M.t - M.b;
  const from = answer.grid.from;
  const to = from + (answer.grid.pool.length - 1) * answer.grid.step;
  const x = (t) => M.l + ((t - from) / (to - from)) * plotW;
  const top = view.mode === "pool" ? Math.max(1, answer.accounts.length) * 100 : 100;
  const y = (v) => M.t + plotH - (v / top) * plotH;
  return { width, height, plotW, plotH, from, to, x, y, top };
}

function axes(svg, f, now) {
  el(
    "rect",
    { x: f.x(now), y: M.t, width: f.x(f.to) - f.x(now), height: f.plotH, class: "future" },
    svg,
  );
  for (let k = 0; k <= 5; k++) {
    const v = (f.top * k) / 5;
    el("line", { x1: M.l, x2: f.width - M.r, y1: f.y(v), y2: f.y(v), class: "grid" }, svg);
    el("text", { x: M.l - 6, y: f.y(v) + 4, "text-anchor": "end" }, svg).textContent = `${v}%`;
  }
  for (const t of midnights(f.from, f.to)) {
    const px = f.x(t);
    el("line", { x1: px, x2: px, y1: M.t, y2: M.t + f.plotH, class: "grid" }, svg);
    el("text", { x: px + 4, y: f.height - 6, "text-anchor": "start" }, svg).textContent =
      dayName(t);
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

function limit(svg, f, value, words) {
  el("line", { x1: M.l, x2: f.width - M.r, y1: f.y(value), y2: f.y(value), class: "limit" }, svg);
  const label = { x: f.width - M.r - 4, y: f.y(value) - 5, "text-anchor": "end" };
  el("text", { ...label, class: "limit-label halo" }, svg).textContent = words;
}

/** The pool's line, measured up to now and forecast after, and its hover rows at hour `k`. */
function drawPool(svg, f, answer, colours) {
  const { from, step, pool } = answer.grid;
  const points = pool.map((v, k) => [from + k * step, v]).filter(([, v]) => v !== null);
  limit(svg, f, 0, "pool empty");
  line(
    svg,
    f,
    points.filter(([t]) => t <= answer.now),
    "var(--fg)",
    false,
  );
  line(
    svg,
    f,
    points.filter(([t]) => t >= answer.now - step),
    "var(--fg)",
    true,
  );
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
  answer.accounts.forEach((a, i) => {
    if (view.hidden.has(a.email)) return;
    line(svg, f, a.measured, colours[i], false);
    line(svg, f, a.forecast, colours[i], true);
  });
  return (k) => ({
    rows: answer.accounts
      .map((a, i) => ({ label: a.label, value: a.hourly[k], colour: colours[i], email: a.email }))
      .filter((r) => r.value !== null && !view.hidden.has(r.email)),
    total: false,
  });
}

function nowLine(svg, f, now) {
  el("line", { x1: f.x(now), x2: f.x(now), y1: M.t - 12, y2: M.t + f.plotH, class: "now" }, svg);
  const at = { y: M.t - 4 };
  el(
    "text",
    { ...at, x: f.x(now) + 4, "text-anchor": "start", class: "now-label halo" },
    svg,
  ).textContent = `now · ${clockName(now)} CET`;
  el("text", { ...at, x: f.x(now) - 4, "text-anchor": "end", class: "halo" }, svg).textContent =
    "measured";
  el("text", { ...at, x: f.x(now) + 124, "text-anchor": "start", class: "halo" }, svg).textContent =
    "forecast at the 24 h burn";
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
    const t = from + ((event.offsetX - M.l) / f.plotW) * (f.to - from);
    const k = Math.min(pool.length - 1, Math.max(0, Math.round((t - from) / step)));
    const at = from + k * step;
    cross.setAttribute("x1", f.x(at));
    cross.setAttribute("x2", f.x(at));
    cross.setAttribute("visibility", "visible");
    const { rows, total } = rowsAt(k);
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
  axes(svg, f, answer.now);
  const rowsAt =
    view.mode === "pool"
      ? drawPool(svg, f, answer, colours)
      : drawAccounts(svg, f, answer, colours);
  nowLine(svg, f, answer.now);
  hover(svg, f, answer, rowsAt);
}
