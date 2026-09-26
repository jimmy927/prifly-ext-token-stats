// The main chart: stacked bars or lines over time, a crosshair tooltip, and
// a drag that zooms into what it covers.

import { bucketName, fmt, niceMax, timeTicks } from "./format.js";
import { hideTip, showTip } from "./tip.js";

const NS = "http://www.w3.org/2000/svg";
const M = { l: 56, r: 12, t: 8, b: 22 };

export function el(tag, attrs, parent) {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  parent?.appendChild(node);
  return node;
}

/** Where things go: time and value to pixels, for this answer and this box. */
function frame(host, answer, visible) {
  const width = Math.max(host.clientWidth, 200);
  const height = Math.max(host.clientHeight, 120);
  const n = answer.buckets.length;
  const x0 = answer.buckets[0] ?? answer.from;
  const x1 = x0 + n * answer.bucket;
  const plotW = width - M.l - M.r;
  const plotH = height - M.t - M.b;
  const x = (t) => M.l + ((t - x0) / (x1 - x0)) * plotW;
  const time = (px) => x0 + ((px - M.l) / plotW) * (x1 - x0);
  return { width, height, n, x0, x1, plotW, plotH, x, time, top: niceMax(peak(answer, visible)) };
}

function peak(answer, visible) {
  if (visible.kind === "lines") {
    return Math.max(0, ...visible.series.flatMap((s) => s.values));
  }
  let most = 0;
  for (let k = 0; k < answer.buckets.length; k++) {
    let sum = 0;
    for (const s of visible.series) sum += s.values[k] ?? 0;
    most = Math.max(most, sum);
  }
  return most;
}

function axes(svg, f) {
  const y = (v) => M.t + f.plotH - (v / f.top) * f.plotH;
  for (let k = 0; k <= 4; k++) {
    const v = (f.top * k) / 4;
    el("line", { x1: M.l, x2: f.width - M.r, y1: y(v), y2: y(v), class: "grid" }, svg);
    el("text", { x: M.l - 6, y: y(v) + 4, "text-anchor": "end" }, svg).textContent = fmt(v);
  }
  for (const tick of timeTicks(f.x0, f.x1, f.plotW)) {
    const px = f.x(tick.t);
    el("line", { x1: px, x2: px, y1: M.t + f.plotH, y2: M.t + f.plotH + 4, class: "axis" }, svg);
    el("text", { x: px, y: f.height - 6, "text-anchor": "middle" }, svg).textContent = tick.label;
  }
  el(
    "line",
    { x1: M.l, x2: f.width - M.r, y1: M.t + f.plotH, y2: M.t + f.plotH, class: "axis" },
    svg,
  );
  return y;
}

function bars(svg, f, visible, y) {
  const bw = f.plotW / f.n;
  const gap = bw > 6 ? 2 : bw > 3 ? 1 : 0;
  const base = new Float64Array(f.n);
  visible.series.forEach((s, j) => {
    let d = "";
    for (let k = 0; k < f.n; k++) {
      const v = s.values[k] ?? 0;
      if (v <= 0) continue;
      const top = y(base[k] + v);
      const bottom = y(base[k]);
      base[k] += v;
      const h = Math.max(0.5, bottom - top - (base[k] > v ? 1 : 0));
      d += `M${(M.l + k * bw + gap / 2).toFixed(1)} ${top.toFixed(1)}h${Math.max(0.6, bw - gap).toFixed(1)}v${h.toFixed(1)}h${-Math.max(0.6, bw - gap).toFixed(1)}Z`;
    }
    if (d !== "") el("path", { d, fill: visible.colours[j] }, svg);
  });
}

function lines(svg, f, visible, y) {
  const bw = f.plotW / f.n;
  visible.series.forEach((s, j) => {
    const d = s.values
      .map(
        (v, k) => `${k === 0 ? "M" : "L"}${(M.l + (k + 0.5) * bw).toFixed(1)} ${y(v).toFixed(1)}`,
      )
      .join("");
    el(
      "path",
      {
        d,
        fill: "none",
        stroke: visible.colours[j],
        "stroke-width": 2,
        "stroke-linejoin": "round",
      },
      svg,
    );
  });
}

function tipAt(event, answer, visible, k) {
  const rows = visible.series
    .map((s, j) => ({ label: s.label, value: s.values[k] ?? 0, colour: visible.colours[j] }))
    .filter((r) => r.value > 0)
    .sort((a, b) => b.value - a.value);
  showTip(event, bucketName(answer.buckets[k], answer.bucket), rows);
}

/** Hover, drag-to-zoom and double-click-to-go-back, on one transparent layer. */
function interact(svg, f, answer, visible, handlers) {
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
  const brush = el("rect", { y: M.t, height: f.plotH, class: "brush", visibility: "hidden" }, svg);
  let start = null;
  const px = (event) => Math.min(Math.max(event.offsetX, M.l), M.l + f.plotW);
  layer.addEventListener("mousedown", (event) => {
    start = px(event);
    hideTip();
  });
  layer.addEventListener("mousemove", (event) => {
    const at = px(event);
    if (start !== null) {
      brush.setAttribute("x", Math.min(start, at));
      brush.setAttribute("width", Math.abs(at - start));
      brush.setAttribute("visibility", "visible");
      return;
    }
    const k = Math.min(f.n - 1, Math.floor(((at - M.l) / f.plotW) * f.n));
    const mid = M.l + ((k + 0.5) * f.plotW) / f.n;
    cross.setAttribute("x1", mid);
    cross.setAttribute("x2", mid);
    cross.setAttribute("visibility", "visible");
    tipAt(event, answer, visible, k);
  });
  const end = (event) => {
    if (start === null) return;
    const at = px(event);
    const [a, b] = [Math.min(start, at), Math.max(start, at)];
    start = null;
    brush.setAttribute("visibility", "hidden");
    if (b - a > 6) handlers.onZoom(f.time(a), f.time(b));
  };
  layer.addEventListener("mouseup", end);
  layer.addEventListener("mouseleave", (event) => {
    end(event);
    cross.setAttribute("visibility", "hidden");
    hideTip();
  });
  layer.addEventListener("dblclick", () => handlers.onBack());
}

/**
 * Draw `answer` into `host`. `visible` is the series shown (the legend can
 * hide some), their colours, and "bars" or "lines".
 */
export function drawChart(host, answer, visible, handlers) {
  host.replaceChildren();
  if (visible.series.length === 0) {
    host.innerHTML = '<div class="empty">No calls in this stretch with these filters.</div>';
    return;
  }
  const f = frame(host, answer, visible);
  const svg = el("svg", { width: f.width, height: f.height, role: "img" }, host);
  svg.setAttribute("aria-label", "Tokens over time");
  const y = axes(svg, f);
  if (visible.kind === "lines") lines(svg, f, visible, y);
  else bars(svg, f, visible, y);
  interact(svg, f, answer, visible, handlers);
}
