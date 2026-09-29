// The Code view: token spend and the lines of code added on the same time
// axis, for all repositories or one, and a table per repository with the
// dollars each thousand lines cost. The extension answers at `api/code`.

import { drawChart } from "./chart.js";
import { colours, esc, fmt, rangeName, usd, widthName } from "./format.js";

/** Kept with the page's other choices (`localStorage["token-stats"].code`). */
export const codeChoices = { repo: "", byRepo: false };

let host = null;
let answer = null;
let asked = 0;
let sortKey = "spend";

const $ = (id) => document.getElementById(id);
const dash = "—";
const percent = (share) => (share === null ? dash : `${(share * 100).toFixed(1)}%`);
const perK = (n) => (n === null ? dash : usd(n));

/**
 * `saved` is what the page kept last time. `page` gives what the shared
 * controls chose (`asked()`: from, to, bucket), the page's `save`, and how a
 * drag on a chart zooms (`zoom`) and goes back (`back`).
 */
export function initCode(saved, page) {
  host = page;
  if (typeof saved?.repo === "string") codeChoices.repo = saved.repo;
  codeChoices.byRepo = saved?.byRepo === true;
}

/** The stretch the last answer covers, for panning from; null before one. */
export const shownCode = () => (answer === null ? null : { from: answer.from, to: answer.to });

export function codeControls() {
  const select = $("code-repo");
  select.onchange = () => {
    codeChoices.repo = select.value;
    host.save();
    void loadCode();
  };
  const split = $("code-split");
  split.checked = codeChoices.byRepo;
  split.onchange = () => {
    codeChoices.byRepo = split.checked;
    host.save();
    void loadCode();
  };
}

function retry() {
  if (document.body.dataset.view === "code") void loadCode();
}

export async function loadCode() {
  const { from, to, bucket } = host.asked();
  const query = new URLSearchParams({
    from: String(Math.round(from)),
    to: String(Math.round(to)),
    bucket: String(bucket),
    tz: String(-new Date().getTimezoneOffset()),
    repo: codeChoices.repo,
    by: codeChoices.byRepo ? "repo" : "none",
    top: "10",
  });
  const mine = ++asked;
  const response = await fetch(`api/code?${query}`);
  const body = await response.json();
  if (mine !== asked) return;
  if (!response.ok) {
    $("code-note").textContent = body.error ?? response.statusText;
    return;
  }
  answer = body;
  drawCode();
  // The first read of a long history takes a while: ask again until it is there.
  if (!body.ready) setTimeout(retry, 2000);
}

/** One line under the bar: what the stretch is, and what is missing from it. */
function note() {
  const missing = answer.rows.filter((r) => r.lines === null && r.spend > 0).length;
  const parts = [`${rangeName(answer.from, answer.to)} · ${widthName(answer.bucket)} per bar`];
  if (!answer.ready) parts.push("reading git history…");
  else if (missing > 0) {
    parts.push(
      `${missing} repositor${missing === 1 ? "y" : "ies"} with no checkout here: no lines`,
    );
  }
  $("code-note").textContent = parts.join(" · ");
}

function drawSelector() {
  const select = $("code-repo");
  const names = answer.repos.includes(codeChoices.repo)
    ? answer.repos
    : [codeChoices.repo, ...answer.repos];
  select.innerHTML = `<option value="">All repositories</option>${names
    .filter((name) => name !== "")
    .map((name) => `<option value="${esc(name)}">${esc(name)}</option>`)
    .join("")}`;
  select.value = codeChoices.repo;
}

function drawTiles() {
  const { spend, lines, perK: cost } = answer.totals;
  const tile = (k, v, h) =>
    `<div class="tile"><div class="k">${k}</div><div class="v">${v}</div><div class="h">${h}</div></div>`;
  $("code-tiles").innerHTML = [
    tile("Spend", usd(spend), "At API list prices, in this stretch"),
    tile("Lines added", fmt(lines), "Code files, on the default branch"),
    tile(
      "$ per 1k lines",
      perK(cost),
      "Spend of repositories with a checkout here, over their lines",
    ),
  ].join("");
}

/**
 * Each repository's colour: the same in both charts, the legend and the
 * table. Split by repository the charts' series set it; otherwise the table's
 * rows wear their own colours, and the one total line the first.
 */
function colourMap() {
  const chart = colours(answer.cost);
  const rows = colours(answer.rows);
  const byKey = new Map(answer.rows.map((r, i) => [r.key, rows[i]]));
  for (const [i, s] of answer.cost.entries()) if (answer.byRepo) byKey.set(s.key, chart[i]);
  return byKey;
}

function drawLegend(colourOf) {
  const legend = $("code-legend");
  legend.replaceChildren();
  if (!answer.byRepo) return;
  for (const [i, s] of answer.cost.entries()) {
    const line = answer.lines[i];
    const item = document.createElement("span");
    item.innerHTML = `<i class="sw" style="background:${colourOf.get(s.key)}"></i><span>${esc(s.label)} · ${usd(s.total)} · ${fmt(line?.total ?? 0)} lines</span>`;
    legend.appendChild(item);
  }
}

function drawCharts() {
  const handlers = { onZoom: host.zoom, onBack: host.back };
  const shades = colours(answer.cost);
  const chart = (id, series, format, label, empty) =>
    drawChart(
      $(id),
      answer,
      {
        series: series.some((s) => s.total > 0) ? series : [],
        colours: shades,
        kind: "bars",
        format,
        label,
        empty,
      },
      handlers,
    );
  chart("code-cost", answer.cost, usd, "Token spend over time", "No spend in this stretch.");
  chart(
    "code-lines",
    answer.lines,
    fmt,
    "Lines added over time",
    "No lines added in this stretch.",
  );
}

const COLUMNS = [
  { key: "spend", label: "Spend", show: (r) => usd(r.spend) },
  { key: "lines", label: "Lines added", show: (r) => (r.lines === null ? dash : fmt(r.lines)) },
  { key: "perK", label: "$ per 1k lines", show: (r) => perK(r.perK) },
];

/** Sorted by the column, biggest first; a missing value last. */
function sorted(rows) {
  return [...rows].sort((a, b) => {
    const [x, y] = [a[sortKey], b[sortKey]];
    return (y ?? Number.NEGATIVE_INFINITY) - (x ?? Number.NEGATIVE_INFINITY);
  });
}

function bar(value, colour) {
  const width = value === null ? 0 : value * 100;
  return `<span class="share"><i style="width:${width.toFixed(1)}%;background:${colour}"></i></span> <span class="num">${percent(value)}</span>`;
}

function drawTable(colourOf) {
  const arrow = (key) => (key === sortKey ? " ↓" : "");
  const head = `<tr><th>Repository</th>${COLUMNS.map((c) => `<th class="num" data-key="${c.key}">${c.label}${arrow(c.key)}</th>`).join("")}<th data-key="shareSpend">Share of spend${arrow("shareSpend")}</th><th data-key="shareLines">Share of lines${arrow("shareLines")}</th></tr>`;
  const rows = sorted(answer.rows);
  const body = rows
    .map((r, i) => {
      const colour = colourOf.get(r.key) ?? "var(--other)";
      const chosen = r.key === codeChoices.repo ? " chosen" : "";
      return `<tr class="row${chosen}" data-i="${i}"><td class="name" title="${esc(r.label)}"><i class="sw" style="background:${colour}"></i> ${esc(r.label)}</td>${COLUMNS.map((c) => `<td class="num">${c.show(r)}</td>`).join("")}<td>${bar(r.shareSpend, colour)}</td><td>${r.shareLines === null ? dash : bar(r.shareLines, colour)}</td></tr>`;
    })
    .join("");
  const table = $("code-table");
  table.innerHTML = `<thead>${head}</thead><tbody>${body}</tbody>`;
  for (const th of table.querySelectorAll("th[data-key]")) {
    th.addEventListener("click", () => {
      sortKey = th.dataset.key;
      drawTable(colourOf);
    });
  }
  for (const tr of table.querySelectorAll("tr.row")) {
    tr.title = "Double-click to show only this repository";
    tr.addEventListener("dblclick", () => {
      codeChoices.repo = rows[Number(tr.dataset.i)].key;
      host.save();
      void loadCode();
    });
  }
}

export function drawCode() {
  if (answer === null) return;
  note();
  drawSelector();
  drawTiles();
  const colourOf = colourMap();
  drawLegend(colourOf);
  drawCharts();
  drawTable(colourOf);
}
