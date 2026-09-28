// The Forecast view's cost per day: dollars at API list prices, per account
// stacked or the pool's total, from the transcripts (`history.ts`). Never a
// % of any limit: the dollars that reached 100% differed 2.8-fold.

import { el } from "./chart.js";
import { clockName, dayName, esc, niceMax, usd } from "./format.js";
import { hideTip, showTip } from "./tip.js";

const M = { l: 56, r: 12, t: 16, b: 22 };

/** Each day's stacked segments: per account in `mode` "accounts", one pool total otherwise. */
export function costStacks(cost, colours, labels, mode) {
  return cost.days.map((_, k) => {
    const parts = cost.accounts.map((a, i) => ({
      label: labels[i],
      value: a.values[k] ?? 0,
      colour: colours[i],
    }));
    const total = parts.reduce((s, p) => s + p.value, 0);
    return mode === "pool"
      ? { total, parts: [{ label: "Pool", value: total, colour: "var(--fg)" }] }
      : { total, parts };
  });
}

function legend(host, answer, colours, mode) {
  host.innerHTML =
    mode === "pool"
      ? `<span class="key"><i class="sw" style="background:var(--fg)"></i>all ${answer.accounts.length} accounts together</span>`
      : answer.accounts
          .map(
            (a, i) =>
              `<span class="key"><i class="sw" style="background:${colours[i]}"></i>${esc(a.label)}</span>`,
          )
          .join("");
}

/** Draw `answer.cost` into `host`, its key into `legendHost`. */
export function drawCostHistory(host, legendHost, answer, colours, mode) {
  host.replaceChildren();
  legend(legendHost, answer, colours, mode);
  const { cost } = answer;
  const labels = answer.accounts.map((a) => a.label);
  const stacks = costStacks(cost, colours, labels, mode);
  const width = Math.max(host.clientWidth, 300);
  const height = Math.max(host.clientHeight, 120);
  const plotW = width - M.l - M.r;
  const plotH = height - M.t - M.b;
  const top = niceMax(Math.max(0, ...stacks.map((s) => s.total)));
  const y = (v) => M.t + plotH - (v / top) * plotH;
  const svg = el("svg", { width, height, role: "img" }, host);
  svg.setAttribute("aria-label", "Cost per day in dollars at API list prices");
  // Fifths of niceMax's tops are round dollars: $600 steps to $3.0k, not $750.
  for (let k = 0; k <= 5; k++) {
    const v = (top * k) / 5;
    el("line", { x1: M.l, x2: width - M.r, y1: y(v), y2: y(v), class: "grid" }, svg);
    el("text", { x: M.l - 6, y: y(v) + 4, "text-anchor": "end" }, svg).textContent = usd(v);
  }
  const bw = plotW / Math.max(1, stacks.length);
  stacks.forEach((s, k) => {
    let at = 0;
    for (const p of s.parts) {
      if (p.value <= 0) continue;
      el(
        "rect",
        {
          x: M.l + k * bw + 3,
          y: y(at + p.value),
          width: Math.max(1, bw - 6),
          height: y(at) - y(at + p.value),
          fill: p.colour,
        },
        svg,
      );
      at += p.value;
    }
    const today = k === stacks.length - 1;
    el(
      "text",
      { x: M.l + (k + 0.5) * bw, y: height - 6, "text-anchor": "middle" },
      svg,
    ).textContent = today ? "today" : dayName(cost.days[k]).replace(/ \S+$/, "");
  });
  el("line", { x1: M.l, x2: width - M.r, y1: y(0), y2: y(0), class: "axis" }, svg);
  const layer = el(
    "rect",
    { x: M.l, y: M.t, width: plotW, height: plotH, fill: "transparent" },
    svg,
  );
  layer.addEventListener("mousemove", (event) => {
    const k = Math.min(stacks.length - 1, Math.max(0, Math.floor((event.offsetX - M.l) / bw)));
    const today = k === stacks.length - 1;
    const title = `${dayName(cost.days[k])}${today ? ` · so far, to ${clockName(answer.now)} CET` : ""} · cost`;
    const rows = mode === "pool" ? stacks[k].parts : stacks[k].parts.slice().reverse();
    showTip(event, title, rows, ["Pool", usd(stacks[k].total)], usd);
  });
  layer.addEventListener("mouseleave", hideTip);
}
