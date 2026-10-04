// The page: what the reader chose, asking the extension for it, and drawing
// the answer. The extension answers at `api/…` beside this page.

import { drawChart } from "./chart.js";
import { BUCKETS, DAY, KINDS, METRIC_ROW, METRICS, RANGES, SEC, SPLITS } from "./choices.js";
import { codeChoices, codeControls, drawCode, initCode, loadCode, shownCode } from "./code.js";
import { drawHeat, drawOverview, drawTable } from "./extras.js";
import { choices, drawForecast, forecastControls, initForecast, loadForecast } from "./forecast.js";
import {
  colours,
  esc,
  fmt,
  measureIsCost,
  rangeName,
  toneColour,
  val,
  widthName,
} from "./format.js";
import { openPicker } from "./picker.js";
import { drawSimulator } from "./simulator.js";
import { showView, VIEWS, viewOf } from "./views.js";

const saved = (() => {
  try {
    return JSON.parse(localStorage.getItem("token-stats") ?? "{}");
  } catch {
    return {};
  }
})();

const state = {
  /** "usage": the chart and its tables; "forecast": the accounts' limits (forecast.js); "code": spend and lines (code.js). */
  view: viewOf(saved.view),
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
  const { view, range, bucket, split, metric, kind, filters } = state;
  try {
    localStorage.setItem(
      "token-stats",
      JSON.stringify({
        version: 2,
        view,
        range,
        bucket,
        split,
        metric,
        kind,
        filters,
        forecast: choices,
        code: codeChoices,
      }),
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
  // A model beyond the chart's top lines still wears its own shade in the table.
  const colourOf = (key) => {
    const tone = answer.rows.find((r) => r.key === key)?.tone;
    if (tone != null) return toneColour(tone);
    return visible.allColours[visible.all.findIndex((s) => s.key === key)] ?? "var(--other)";
  };
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
  drawSimulator(
    document.getElementById("sim"),
    answer.simulation,
    Object.values(state.filters).some((values) => values.length > 0),
  );
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
  if (state.metric === "prompts" || state.metric === "promptTokens") {
    parts.push(
      "Prompts you wrote: your own words, without what prifly adds, pasted text, commands or button prompts. Tokens are estimated from the length.",
    );
    if (state.split === "model") parts.push("A prompt's model is the one that answered it.");
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

/** Ask again for the view shown that has a chart to zoom, pan and reshape: Usage or Code. */
function reload() {
  return state.view === "code" ? loadCode() : load();
}

function zoomTo(from, to) {
  state.history.push(state.window);
  state.window = { from, to: Math.max(to, from + 30 * SEC) };
  void reload();
}

function back() {
  if (state.history.length === 0 && state.window === null) return;
  state.window = state.history.pop() ?? null;
  void reload();
}

function pan(direction) {
  const { from, to } = (state.view === "code" ? shownCode() : state.answer) ?? stretch();
  const shift = ((to - from) / 2) * direction;
  state.history.push(state.window);
  state.window = { from: from + shift, to: to + shift };
  void reload();
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

/** The status line and the reading are each view's own. */
function show() {
  showView(state.view, {
    usage: () => {
      void status(false);
      void load();
    },
    forecast: () => void loadForecast(),
    code: () => {
      void status(false);
      void loadCode();
    },
  });
}

function controls() {
  segmented(
    "view",
    VIEWS,
    () => state.view,
    (v) => {
      state.view = v;
      show();
    },
  );
  forecastControls(segmented);
  codeControls();
  segmented(
    "range",
    RANGES.map(([l, ms]) => [ms, l]),
    () => (state.window === null ? state.range : -1),
    (ms) => {
      state.range = ms;
      state.window = null;
      state.history = [];
      void reload().then(controls);
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
    void reload();
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
    // The Forecast view's status line is its own (forecast.js).
    if (state.view === "forecast") return;
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
  if (state.view === "forecast") return loadForecast();
  await status(false);
  await reload();
});

addEventListener("keydown", (event) => {
  if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return;
  if (state.view === "forecast") return;
  if (event.key === "Backspace") back();
  else if (event.key === "ArrowLeft") pan(-1);
  else if (event.key === "ArrowRight") pan(1);
});

let resizing = 0;
addEventListener("resize", () => {
  clearTimeout(resizing);
  resizing = setTimeout(redraw, 120);
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
  redraw();
});

function redraw() {
  if (state.view === "forecast") drawForecast();
  else if (state.view === "code") drawCode();
  else draw();
}

initForecast(saved.forecast, save);
initCode(saved.code, {
  save,
  zoom: zoomTo,
  back,
  /** What the page asks for: the time and bucket the reader chose. */
  asked: () => ({ ...stretch(), bucket: state.bucket }),
});
controls();
void status(true);
show();
setInterval(() => {
  if (state.view === "forecast") void loadForecast();
  else if (state.window === null) void reload();
}, 60_000);
