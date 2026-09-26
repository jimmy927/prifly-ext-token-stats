// What sits around the main chart: the overview of all history under it, the
// breakdown table and the weekday-by-hour map.

import { el } from "./chart.js";
import { esc, fmt, widthName } from "./format.js";
import { hideTip, showTip } from "./tip.js";

/** The whole history as one filled line, the shown stretch lit, and a drag to pick another. */
export function drawOverview(host, answer, onPick) {
  host.replaceChildren();
  const { buckets, values, bucket } = answer.overview;
  if (buckets.length === 0) return;
  const width = Math.max(host.clientWidth, 200);
  const height = host.clientHeight || 54;
  const l = 56;
  const r = 12;
  const x0 = buckets[0];
  const x1 = buckets[buckets.length - 1] + bucket;
  const x = (t) => l + ((t - x0) / (x1 - x0)) * (width - l - r);
  const time = (px) => x0 + ((px - l) / (width - l - r)) * (x1 - x0);
  const top = Math.max(1, ...values);
  const svg = el("svg", { width, height }, host);
  const y = (v) => height - 14 - (v / top) * (height - 18);
  const pts = values.map((v, k) => `${x(buckets[k] + bucket / 2).toFixed(1)},${y(v).toFixed(1)}`);
  el(
    "path",
    {
      d: `M${l},${y(0)}L${pts.join("L")}L${width - r},${y(0)}Z`,
      fill: "var(--s0)",
      "fill-opacity": 0.25,
    },
    svg,
  );
  el(
    "path",
    { d: `M${pts.join("L")}`, fill: "none", stroke: "var(--s0)", "stroke-width": 1.2 },
    svg,
  );
  const a = Math.max(l, x(answer.from));
  const b = Math.min(width - r, x(answer.to));
  el("rect", { x: a, y: 1, width: Math.max(2, b - a), height: height - 15, class: "window" }, svg);
  el("text", { x: l, y: height - 2 }, svg).textContent =
    `All history, ${widthName(bucket)} per point`;
  let start = null;
  const brush = el(
    "rect",
    { y: 1, height: height - 15, class: "brush", visibility: "hidden" },
    svg,
  );
  svg.addEventListener("mousedown", (event) => {
    start = event.offsetX;
  });
  svg.addEventListener("mousemove", (event) => {
    if (start === null) return;
    brush.setAttribute("x", Math.min(start, event.offsetX));
    brush.setAttribute("width", Math.abs(event.offsetX - start));
    brush.setAttribute("visibility", "visible");
  });
  const end = (event) => {
    if (start === null) return;
    const [p, q] = [Math.min(start, event.offsetX), Math.max(start, event.offsetX)];
    start = null;
    brush.setAttribute("visibility", "hidden");
    // A click, not a drag: the same width of window, centred where it landed.
    if (q - p < 4) {
      const half = (answer.to - answer.from) / 2;
      onPick(time(p) - half, time(p) + half);
    } else onPick(time(p), time(q));
  };
  svg.addEventListener("mouseup", end);
  svg.addEventListener("mouseleave", (event) => end(event));
}

const COLUMNS = [
  { key: "output", label: "Output" },
  { key: "input", label: "Input + cache writes" },
  { key: "cacheRead", label: "Cache reads" },
  { key: "calls", label: "Calls" },
  { key: "sessions", label: "Sessions" },
];

/** Every value of the split in the shown stretch, not only the charted ones. */
export function drawTable(host, rows, colourOf, sortKey, metricKey, onSort, onOnly) {
  const sorted = [...rows].sort((a, b) => b[sortKey] - a[sortKey]);
  const total = rows.reduce((s, r) => s + r[metricKey], 0) || 1;
  const head = `<tr><th>Name</th>${COLUMNS.map((c) => `<th class="num" data-key="${c.key}">${c.label}${c.key === sortKey ? " ↓" : ""}</th>`).join("")}<th>Share</th></tr>`;
  const body = sorted
    .map((r, i) => {
      const colour = colourOf(r.key);
      const share = (r[metricKey] / total) * 100;
      return `<tr class="row" data-i="${i}"><td class="name" title="${esc(r.label)}"><i class="sw" style="background:${colour}"></i> ${esc(r.label)}</td>${COLUMNS.map((c) => `<td class="num">${fmt(r[c.key])}</td>`).join("")}<td><span class="share"><i style="width:${share.toFixed(1)}%;background:${colour}"></i></span> <span class="num">${share.toFixed(1)}%</span></td></tr>`;
    })
    .join("");
  host.innerHTML = `<thead>${head}</thead><tbody>${body}</tbody>`;
  for (const th of host.querySelectorAll("th[data-key]")) {
    th.addEventListener("click", () => onSort(th.dataset.key));
  }
  for (const tr of host.querySelectorAll("tr.row")) {
    const row = sorted[Number(tr.dataset.i)];
    tr.title = "Double-click to show only this";
    tr.addEventListener("dblclick", () => onOnly(row.key));
  }
}

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** Seven rows of 24 hours: when in the week the tokens go. */
export function drawHeat(host, heat) {
  host.replaceChildren();
  const width = Math.max(host.clientWidth, 260);
  const l = 34;
  const cell = Math.max(6, Math.min(28, (width - l - 4) / 24));
  const height = 7 * cell + 20;
  const svg = el("svg", { width: l + 24 * cell + 4, height }, host);
  const top = Math.max(1, ...heat.flat());
  heat.forEach((row, d) => {
    el("text", { x: l - 6, y: d * cell + cell / 2 + 4, "text-anchor": "end" }, svg).textContent =
      DAYS[d];
    row.forEach((v, h) => {
      const rect = el(
        "rect",
        {
          x: l + h * cell + 1,
          y: d * cell + 1,
          width: cell - 2,
          height: cell - 2,
          rx: 2,
          fill: "var(--s0)",
        },
        svg,
      );
      rect.setAttribute("fill-opacity", v === 0 ? 0.04 : 0.12 + 0.88 * Math.sqrt(v / top));
      rect.addEventListener("mousemove", (event) =>
        showTip(
          event,
          `${DAYS[d]} ${String(h).padStart(2, "0")}:00–${String(h + 1).padStart(2, "0")}:00`,
          [{ label: "In this stretch", value: v, colour: "var(--s0)" }],
        ),
      );
      rect.addEventListener("mouseleave", hideTip);
    });
  });
  for (const h of [0, 6, 12, 18]) {
    el("text", { x: l + h * cell + 1, y: height - 4 }, svg).textContent =
      `${String(h).padStart(2, "0")}:00`;
  }
}
