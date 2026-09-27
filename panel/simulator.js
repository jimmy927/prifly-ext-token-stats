// The context window simulator: today's cost, and what it would have been
// with a smaller window, beside the same for the stretch on screen. The
// numbers come from `simulate.ts`; this only lays them out.

import { esc, fmt, usd } from "./format.js";

// Rounded: a call split across repositories counts in parts.
const count = (n) => Math.round(n).toLocaleString("en-US");

/** "−$2.10 · 5.1%", or a dash when nothing would be saved. */
function saving(actual, cost) {
  const saved = actual - cost;
  if (saved < 0.005) return `<span class="sim-none">—</span>`;
  const pct = actual > 0 ? (saved / actual) * 100 : 0;
  return `−${usd(saved)} <span class="sim-pct">${pct.toFixed(pct < 10 ? 1 : 0)}%</span>`;
}

function bar(actual, cost) {
  const share = actual > 0 ? Math.min(100, (cost / actual) * 100) : 0;
  return `<span class="sim-bar" aria-hidden="true"><i style="width:${share.toFixed(1)}%"></i></span>`;
}

/** A window's row: today's cost with a bar of it against today's actual, then the stretch's. */
function row(label, title, today, stretch, cost) {
  return `<tr title="${esc(title)}"><td class="name">${label}</td><td class="num">${bar(today.actual, cost.today)} ${usd(cost.today)}</td><td class="num">${saving(today.actual, cost.today)}</td><td class="num sim-gap">${usd(cost.stretch)}</td><td class="num">${saving(stretch.actual, cost.stretch)}</td></tr>`;
}

function headline(today) {
  if (today.calls === 0)
    return `<div class="sim-today">No priced calls today${today.unpriced > 0 ? ` (${count(today.unpriced)} unpriced)` : ""}.</div>`;
  const unpriced = today.unpriced > 0 ? ` · ${count(today.unpriced)} unpriced calls left out` : "";
  return `<div class="sim-today">This is your cost today: <b>${usd(today.actual)}</b></div><div class="sim-sub">${count(today.calls)} calls · the largest carried ${fmt(today.largest)} tokens of context${unpriced}</div>`;
}

/** The whole panel, from the answer's `simulation`. `filtered` says whether filters narrow it. */
export function drawSimulator(host, simulation, filtered) {
  const { today, stretch } = simulation;
  const rows = [
    row("As used", "The calls as they ran", today, stretch, {
      today: today.actual,
      stretch: stretch.actual,
    }),
    ...today.windows.map((w, k) => {
      const s = stretch.windows[k];
      const title = `A ${count(w.window)}-token window would have cut ${count(w.clipped)} of today's ${count(today.calls)} calls, and ${count(s.clipped)} of ${count(stretch.calls)} in this stretch`;
      return row(`${fmt(w.window)} tokens`, title, today, stretch, {
        today: w.cost,
        stretch: s.cost,
      });
    }),
  ];
  host.innerHTML = `${headline(today)}
    <div class="table-scroll"><table class="sim-table">
      <thead><tr><th>Window</th><th class="num">Today</th><th class="num">Saving</th><th class="num sim-gap">This stretch</th><th class="num">Saving</th></tr></thead>
      <tbody>${rows.join("")}</tbody>
    </table></div>
    <div class="note">An estimate, and the most a smaller window could save: a call over the window is cut to it, cache reads first, as if compacted just in time; output unchanged. Not counted: the compaction calls, extra turns, any change in quality.${filtered ? " Follows the filters." : ""}</div>`;
}
