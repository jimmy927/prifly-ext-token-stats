// The page: what the reader chose, asking the extension for it, and drawing
// the answer. The extension answers at `api/…` beside this page.

import { drawChart } from "./chart.js";
import { drawHeat, drawOverview, drawTable } from "./extras.js";
import { colours, esc, fmt, measureIsCost, rangeName, val, widthName } from "./format.js";
import { openPicker } from "./picker.js";

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const RANGES = [
  ["15m", 15 * MIN],
  ["1h", HOUR],
  ["6h", 6 * HOUR],
  ["24h", DAY],
  ["3d", 3 * DAY],
  ["7d", 7 * DAY],
  ["30d", 30 * DAY],
  ["90d", 90 * DAY],
  ["All", 0],
];
const BUCKETS = [
  0,
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
  7 * DAY,
];
export const SPLITS = [
  ["account", "Account"],
  ["model", "Model"],
  ["repo", "Repository"],
  ["folder", "Folder"],
  ["source", "Local/remote"],
  ["session", "Session"],
  ["none", "Total"],
];
const METRICS = [
  ["cost", "Cost"],
  ["output", "Output"],
  ["input", "Input + cache writes"],
  ["cacheRead", "Cache reads"],
  ["all", "All tokens"],
  ["calls", "API calls"],
];
const METRIC_ROW = {
  cost: "cost",
  output: "output",
  input: "input",
  cacheRead: "cacheRead",
  all: "output",
  calls: "calls",
};
const KINDS = [
  ["bars", "Bars"],
  ["lines", "Lines"],
];

const saved = (() => {
  try {
    return JSON.parse(localStorage.getItem("token-stats") ?? "{}");
  } catch {
    return {};
  }
})();

const state = {
  range: saved.range ?? 7 * DAY,
  /** A stretch zoomed into, or null to follow `range` up to now. */
  window: null,
  history: [],
  bucket: saved.bucket ?? 0,
  split: saved.split ?? "account",
  // Cost became the default measure in version 2: a choice saved before it starts on cost.
  metric: saved.version === 2 ? (saved.metric ?? "cost") : "cost",
  kind: saved.kind ?? "bars",
  filters: saved.filters ?? {},
  hidden: new Set(),
  sort: "cost",
  answer: null,
  span: null,
};

function save() {
  const { range, bucket, split, metric, kind, filters } = state;
  try {
    localStorage.setItem(
      "token-stats",
      JSON.stringify({ version: 2, range, bucket, split, metric, kind, filters }),
    );
  } catch {
    // No storage in this frame: the choices last until it closes.
  }
}

function stretch() {
  if (state.window !== null) return state.window;
  const to = Date.now();
  const from = state.range === 0 ? 0 : to - state.range;
  return { from, to };
}

let asked = 0;
async function load() {
  const { from, to } = stretch();
  const query = new URLSearchParams({
    from: String(Math.round(from)),
    to: String(Math.round(to)),
    bucket: String(state.bucket),
    tz: String(-new Date().getTimezoneOffset()),
    split: state.split,
    metric: state.metric,
    filters: JSON.stringify(state.filters),
    top: "8",
  });
  const mine = ++asked;
  const response = await fetch(`api/stats?${query}`);
  const answer = await response.json();
  if (mine !== asked) return;
  if (!response.ok) {
    document.getElementById("chart").innerHTML =
      `<div class="empty">${esc(answer.error ?? response.statusText)}</div>`;
    return;
  }
  state.answer = answer;
  state.span = answer.span;
  draw();
}

function visibleSeries() {
  const all = state.answer.series;
  const cols = colours(all);
  const keep = all.map((s, i) => [s, cols[i]]).filter(([s]) => !state.hidden.has(s.key));
  return {
    series: keep.map(([s]) => s),
    colours: keep.map(([, c]) => c),
    kind: state.kind,
    all,
    allColours: cols,
  };
}

function draw() {
  const answer = state.answer;
  if (answer === null) return;
  measureIsCost(state.metric === "cost");
  const visible = visibleSeries();
  const metricName = METRICS.find(([k]) => k === state.metric)?.[1] ?? "";
  const splitName = SPLITS.find(([k]) => k === state.split)?.[1] ?? "";
  const total = answer.series.reduce((s, x) => s + x.total, 0);
  document.getElementById("title").textContent =
    `${metricName} · ${val(total)} · ${rangeName(answer.from, answer.to)} · ${widthName(answer.bucket)} per bar`;
  drawCostNote(answer.unpriced);
  drawLegend(visible);
  drawChart(document.getElementById("chart"), answer, visible, { onZoom: zoomTo, onBack: back });
  drawOverview(document.getElementById("overview"), answer, zoomTo);
  const colourOf = (key) =>
    visible.allColours[visible.all.findIndex((s) => s.key === key)] ?? "var(--other)";
  document.getElementById("table-title").textContent =
    `By ${splitName.toLowerCase()} in this stretch`;
  drawTable(
    document.getElementById("table"),
    answer.rows,
    colourOf,
    state.sort,
    METRIC_ROW[state.metric],
    (key) => {
      state.sort = key;
      draw();
    },
    only,
  );
  document.getElementById("heat-title").textContent =
    `${metricName} by weekday and hour, in this stretch`;
  drawHeat(document.getElementById("heat"), answer.heat);
  drawFilters();
}

function drawLegend(visible) {
  const host = document.getElementById("legend");
  host.replaceChildren();
  if (state.split === "none") return;
  visible.all.forEach((s, i) => {
    const button = document.createElement("button");
    button.type = "button";
    button.setAttribute("aria-pressed", String(!state.hidden.has(s.key)));
    button.title = `${s.label}: ${val(s.total)}. Click to hide or show; double-click to show only this.`;
    button.innerHTML = `<i class="sw" style="background:${visible.allColours[i]}"></i><span>${esc(s.label)} · ${val(s.total)}</span>`;
    button.addEventListener("click", () => {
      if (state.hidden.has(s.key)) state.hidden.delete(s.key);
      else state.hidden.add(s.key);
      draw();
    });
    button.addEventListener("dblclick", () => only(s.key));
    host.appendChild(button);
  });
}

/** Under the title, while the cost is shown: what the dollars mean and which calls have none. */
function drawCostNote(unpriced) {
  const node = document.getElementById("cost-note");
  const parts = [];
  if (state.metric === "cost") {
    parts.push("At API list prices — on a subscription this is value used, not money billed.");
  }
  if (unpriced.calls > 0) {
    parts.push(
      `${fmt(unpriced.calls)} calls on unpriced models, in no cost: ${unpriced.models.join(", ")}`,
    );
  }
  node.hidden = parts.length === 0;
  node.textContent = parts.join(" · ");
}

/** Keep only this value of the split: a filter, shown as a chip. */
function only(key) {
  if (state.split === "none" || key.startsWith("\u0000")) return;
  state.filters = { ...state.filters, [state.split]: [key] };
  state.hidden.clear();
  save();
  void load();
}

function drawFilters() {
  const host = document.getElementById("filters");
  host.replaceChildren();
  const add = document.createElement("button");
  add.type = "button";
  add.className = "btn";
  add.textContent = "Filter…";
  add.addEventListener("click", () =>
    openPicker(add, state.answer.facets, state.filters, (filters) => {
      state.filters = filters;
      save();
      void load();
    }),
  );
  host.appendChild(add);
  for (const [dim, values] of Object.entries(state.filters)) {
    for (const value of values) host.appendChild(chip(dim, value));
  }
}

function chip(dim, value) {
  const span = document.createElement("span");
  span.className = "chip";
  const name = SPLITS.find(([k]) => k === dim)?.[1] ?? dim;
  const label = state.answer.facets[dim]?.find((f) => f.key === value)?.label ?? value;
  span.innerHTML = `<span>${esc(name)}: ${esc(label)}</span><button type="button" aria-label="Remove">×</button>`;
  span.querySelector("button").addEventListener("click", () => {
    const rest = state.filters[dim].filter((v) => v !== value);
    state.filters = { ...state.filters, [dim]: rest };
    if (rest.length === 0) delete state.filters[dim];
    save();
    void load();
  });
  return span;
}

function zoomTo(from, to) {
  state.history.push(state.window);
  state.window = { from, to: Math.max(to, from + 30 * SEC) };
  void load();
}

function back() {
  if (state.history.length === 0 && state.window === null) return;
  state.window = state.history.pop() ?? null;
  void load();
}

function pan(direction) {
  const { from, to } = state.answer ?? stretch();
  const shift = ((to - from) / 2) * direction;
  state.history.push(state.window);
  state.window = { from: from + shift, to: to + shift };
  void load();
}

function segmented(id, options, get, set) {
  const host = document.getElementById(id);
  host.replaceChildren();
  for (const [value, label] of options) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.setAttribute("aria-pressed", String(get() === value));
    button.addEventListener("click", () => {
      set(value);
      for (const [i, b] of [...host.children].entries())
        b.setAttribute("aria-pressed", String(options[i][0] === get()));
      save();
    });
    host.appendChild(button);
  }
}

function controls() {
  segmented(
    "range",
    RANGES.map(([l, ms]) => [ms, l]),
    () => (state.window === null ? state.range : -1),
    (ms) => {
      state.range = ms;
      state.window = null;
      state.history = [];
      void load().then(controls);
    },
  );
  const select = document.getElementById("bucket");
  select.innerHTML = BUCKETS.map(
    (ms) => `<option value="${ms}">${ms === 0 ? "Auto" : widthName(ms)}</option>`,
  ).join("");
  select.value = String(state.bucket);
  select.onchange = () => {
    state.bucket = Number(select.value);
    save();
    void load();
  };
  segmented(
    "split",
    SPLITS,
    () => state.split,
    (v) => {
      state.split = v;
      state.hidden.clear();
      void load();
    },
  );
  segmented(
    "metric",
    METRICS,
    () => state.metric,
    (v) => {
      state.metric = v;
      void load();
    },
  );
  segmented(
    "kind",
    KINDS,
    () => state.kind,
    (v) => {
      state.kind = v;
      draw();
    },
  );
}

async function status(poll) {
  const node = document.getElementById("status");
  try {
    const s = await (await fetch("api/status")).json();
    const remote =
      s.remote.error !== ""
        ? ` · remote: ${s.remote.error}`
        : ` · ${s.remote.sessions.toLocaleString("en-US")} remote`;
    const archived = ` · ${s.archived.toLocaleString("en-US")} archived`;
    node.textContent = s.ready
      ? `${s.sessions.toLocaleString("en-US")} transcripts${archived}${remote}${s.scanning ? " · reading…" : ""}`
      : "Reading your transcripts for the first time…";
    if (poll && (!s.ready || s.scanning)) setTimeout(() => void status(true), 2000);
  } catch {
    node.textContent = "The extension did not answer.";
  }
}

document.getElementById("refresh").addEventListener("click", async () => {
  document.getElementById("status").textContent = "Reading again…";
  await fetch("api/refresh");
  await status(false);
  await load();
});

addEventListener("keydown", (event) => {
  if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return;
  if (event.key === "Backspace") back();
  else if (event.key === "ArrowLeft") pan(-1);
  else if (event.key === "ArrowRight") pan(1);
});

let resizing = 0;
addEventListener("resize", () => {
  clearTimeout(resizing);
  resizing = setTimeout(draw, 120);
});

// The window's look — its tokens, a skin's or theme's included — once the frame has loaded.
const LOOK = {
  "--background": "--bg",
  "--foreground": "--fg",
  "--card": "--card",
  "--muted": "--muted",
  "--muted-foreground": "--muted-fg",
  "--border": "--border",
  "--accent": "--accent",
  "--font-sans": "--font",
  "--font-mono": "--mono",
};
addEventListener("message", (event) => {
  if (event.data?.type !== "prifly-look") return;
  document.documentElement.classList.toggle("dark", event.data.dark === true);
  for (const [theirs, ours] of Object.entries(LOOK)) {
    const value = event.data.tokens?.[theirs];
    if (typeof value === "string" && value !== "")
      document.documentElement.style.setProperty(ours, value);
  }
  draw();
});

controls();
void status(true);
void load();
setInterval(() => {
  if (state.window === null) void load();
}, 60_000);
