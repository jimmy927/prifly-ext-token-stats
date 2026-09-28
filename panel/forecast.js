// The Forecast view: each account's runway against its weekly reset, the
// burn-down (burndown.js), and how many accounts the pool's burn needs. The
// numbers come from `forecast.ts` at `api/forecast`; this lays them out.

import { burndownNote, burndownSpan, drawBurndown } from "./burndown.js";
import { el } from "./chart.js";
import { clockName, dayName, esc, niceMax } from "./format.js";
import { hideTip, showTip } from "./tip.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const M = { l: 56, r: 12, t: 16, b: 22 };
const TOO_OLD = "This prifly is too old to share account limits — update prifly.";
const NO_READINGS = "No readings yet — the first arrives within 5 minutes.";

/** What the reader chose here; app.js saves them with the rest. */
export const choices = { mode: "accounts", days: 7, headroom: 20 };

let answer = null;

const when = (t) => `${dayName(t)} ${clockName(t)}`;
const hours = (h) => (h < 10 ? `${Math.round(h * 2) / 2} h` : `${Math.round(h)} h`);
const pct = (v) => `${Math.round(v)}%`;
const colourOf = (i) => `var(--s${i % 8})`;
const $ = (id) => document.getElementById(id);

/** A day with an account whose share of it is unknown: no curve before its readings. */
const partial = (d) => d.missing.length > 0;

/**
 * How many accounts the pool's burn needs: the average of the last `days`
 * full days (today left out, and partial days), as accounts' worth of weekly
 * limit a week, plus `headroom` per cent. `rebuilt` are the days averaged
 * that began before the readings (`firstAt`), so reconstructed in whole or
 * part; `left` the partial ones left out. null before the first full day.
 */
export function accountsNeeded(daily, days, headroom, firstAt) {
  const last = daily.slice(0, -1).slice(-days);
  const full = last.filter((d) => !partial(d));
  if (full.length === 0) return null;
  const avg = full.reduce((s, d) => s + d.burn, 0) / full.length;
  const perWeek = (avg * 7) / 100;
  // The epsilon keeps 5.0000000001 accounts from asking for a sixth.
  const need = Math.ceil(perWeek * (1 + headroom / 100) - 1e-9);
  const rebuilt = full.filter((d) => d.start < firstAt).map((d) => d.start);
  const left = last.filter(partial).map((d) => d.start);
  return { avg, perWeek, need, fullDays: full.length, rebuilt, left };
}

/** Local days as words: one, a run "first – last", or a list. */
export function daysName(starts) {
  if (starts.length <= 1) return starts.map(dayName).join("");
  const run = starts.every((t, k) => k === 0 || Math.abs(t - starts[k - 1] - DAY) <= HOUR);
  return run ? `${dayName(starts[0])} – ${dayName(starts.at(-1))}` : starts.map(dayName).join(", ");
}

// ---- Runway per account ----

function runsOut(w) {
  const dry = () => `<span class="small">${Math.round(w.dryHours)} h dry before reset</span>`;
  if (w.outcome === "spent") return `<span class="fc-tag bad">Spent now</span>${dry()}`;
  if (w.outcome === "dry") return `<span class="fc-tag bad">${when(w.runsOutAt)}</span>${dry()}`;
  if (w.outcome === "lasts")
    return `<span class="fc-tag good">Lasts — ${pct(Math.max(0, 100 - w.atReset))} left over</span>`;
  return `<span class="fc-tag muted">Not enough readings yet</span>`;
}

function weeklyBar(w, colour) {
  const spent = Math.min(100, w.percent);
  const proj = w.outcome === "lasts" ? w.atReset : w.outcome === "unknown" ? spent : 100;
  const label =
    w.outcome === "unknown" ? `${pct(w.percent)} → ?` : `${pct(w.percent)} → ${pct(proj)}`;
  const hatch = `repeating-linear-gradient(135deg, ${colour} 0 2px, transparent 2px 5px)`;
  const gone = w.elapsed === null ? "" : `<span class="gone" style="left:${w.elapsed}%"></span>`;
  return `<span class="wk"><span class="wk-bar" aria-hidden="true">
    <span class="proj" style="left:${spent}%;width:${Math.max(0, proj - spent)}%;background:${hatch}"></span>
    <span class="spent" style="width:${spent}%;background:${colour}"></span>${gone}
  </span><span class="wk-label">${label}</span></span>`;
}

function resets(t) {
  if (t === null) return '<span class="sim-none">—</span>';
  const left = (t - answer.now) / HOUR;
  return `${when(t)}<span class="small">${left > 0 ? `in ${hours(left)}` : "passed"}</span>`;
}

function fiveHour(s) {
  if (s === null) return '<span class="sim-none">—</span>';
  const left = s.resetsAt === null ? null : (s.resetsAt - answer.now) / HOUR;
  const words = left === null || left <= 0 ? "idle" : `resets in ${hours(left)}`;
  return `${pct(s.percent)}<span class="small">${words}</span>`;
}

/** The burn and where it comes from; an account at 100 read on its average since the reset burns at least that. */
export function burnCell(w) {
  if (w.ratePerHour === null) return '<span class="sim-none">—</span>';
  const floor = w.rateFrom === "reset" && w.outcome === "spent" ? "≥ " : "";
  const from = w.rateFrom === "reset" ? "avg since reset" : "last 24 h";
  return `${floor}${w.ratePerHour.toFixed(2)} %/h<span class="small">${from}</span>`;
}

/** The banner over the runway: who is out before the reset, and who has no burn to tell. */
export function runwayBanner(read) {
  const spent = read.filter((w) => w.outcome === "spent").length;
  const dry = read.filter((w) => w.outcome === "dry").length;
  const unknown = read.filter((w) => w.outcome === "unknown").length;
  const gap = read.reduce((s, w) => s + w.dryHours, 0);
  const untold =
    unknown === 0 ? "" : ` ${unknown} ${unknown === 1 ? "has" : "have"} too few readings to tell.`;
  if (spent + dry === 0)
    return {
      ok: true,
      html: `<span>${read.length - unknown} of <b>${read.length}</b> accounts last until their weekly reset at their burn.${untold}</span>`,
    };
  const parts = [
    spent > 0 ? `${spent} spent now` : "",
    dry > 0 ? `${dry} run dry at their burn` : "",
  ];
  return {
    ok: false,
    html: `<span aria-hidden="true">⚠</span><span><b>${spent + dry}</b> of <b>${read.length}</b> accounts are out before their weekly reset (${parts.filter(Boolean).join(", ")}) — <b>${Math.round(gap)}</b> account-hours with no tokens.${untold}</span>`,
  };
}

function runwayRow(a, i) {
  const next = a.startsNewSessions ? ' <span class="fc-tag next">new sessions</span>' : "";
  const who = `<td><span class="who"><i class="sw" style="background:${colourOf(i)}"></i>${esc(a.label)}${next}</span></td>`;
  const w = a.weekly;
  if (w === null)
    return `<tr class="row">${who}<td colspan="5" class="sim-none">${NO_READINGS}</td></tr>`;
  const burn = burnCell(w);
  return `<tr class="row" title="${esc(a.email)}, read ${when(w.readAt)} CET">${who}
    <td>${weeklyBar(w, colourOf(i))}</td><td class="num">${burn}</td><td>${runsOut(w)}</td>
    <td>${resets(w.resetsAt)}</td><td>${fiveHour(a.session)}</td></tr>`;
}

function drawRunway() {
  const read = answer.accounts.filter((a) => a.weekly !== null).map((a) => a.weekly);
  const { ok, html } = runwayBanner(read);
  const banner = $("fc-banner");
  banner.hidden = read.length === 0;
  banner.classList.toggle("ok", ok);
  banner.innerHTML = html;
  $("fc-runway").innerHTML = `
    <thead><tr><th>Account</th><th>Weekly limit</th><th class="num">Burn</th><th>Runs out (CET)</th><th>Resets (CET)</th><th>5-hour window</th></tr></thead>
    <tbody>${answer.accounts.map(runwayRow).join("")}</tbody>`;
}

// ---- Accounts needed ----

const needed = () =>
  accountsNeeded(answer.daily, choices.days, choices.headroom, answer.firstAt);

/** Which of the averaged days are reconstructed, and which partial ones it leaves out. */
export function averagedFrom(n) {
  const rebuilt =
    n.rebuilt.length === 0
      ? ""
      : n.rebuilt.length === n.fullDays
        ? "; all reconstructed from the transcripts"
        : `; ${daysName(n.rebuilt)} reconstructed from the transcripts`;
  const left = n.left.length === 0 ? "" : `; ${daysName(n.left)} left out, partial`;
  return `accounts' worth of weekly limit per week${rebuilt}${left}`;
}

function drawTiles() {
  const n = needed();
  const have = answer.accounts.length;
  $("fc-headroom-out").textContent = `${choices.headroom}%`;
  if (n === null) {
    $("fc-tiles").innerHTML =
      `<div class="tile"><div class="k">Connected</div><div class="v">${have}</div><div class="h">accounts — readings began ${when(answer.firstAt)} CET; the average needs a full day, read or reconstructed for every account</div></div>`;
    return;
  }
  const short = n.need > have;
  $("fc-tiles").innerHTML = `
    <div class="tile"><div class="k">Burn, ${n.fullDays}-day average</div><div class="v">${n.perWeek.toFixed(1)}</div><div class="h">${esc(averagedFrom(n))}</div></div>
    <div class="tile"><div class="k">Connected</div><div class="v">${have}</div><div class="h">accounts</div></div>
    <div class="tile ${short ? "bad" : "good"}"><div class="k">Needed with ${choices.headroom}% headroom</div><div class="v">${n.need}</div><div class="h">${short ? `${n.need - have} more to sustain this burn` : "the pool covers this burn"}</div></div>`;
}

function barsKey(refill, n, shown) {
  const key = (cls) =>
    `<svg width="24" height="6"><line x1="0" x2="24" y1="3" y2="3" class="${cls}"/></svg>`;
  const avg =
    n === null
      ? ""
      : `<span class="key">${key("avg")}<span style="color:var(--fg)">average ${pct(n.avg)}/day, last ${n.fullDays} full days</span></span>`;
  const swatch = (cls, words) =>
    `<span class="key"><svg width="12" height="12"><rect x="1" y="1" width="10" height="10" rx="1" class="${cls}"/></svg>${words}</span>`;
  const rebuilt = shown.some((d) => d.start < answer.firstAt)
    ? swatch("day-rebuilt", "reconstructed")
    : "";
  const part = shown.some(partial) ? swatch("day-partial", "partial: an account unknown") : "";
  $("fc-bars-legend").innerHTML = `
    ${swatch("day-read", "pool burn per day, read")}${rebuilt}${part}
    <span class="key">${key("limit")}<span style="color:var(--bad)">${answer.accounts.length} accounts refill ${pct(refill)}/day</span></span>${avg}`;
}

/** A day's bar: read, reconstructed (before the readings), partial, or today's so far. */
function barClass(d, today) {
  if (today) return "day-today";
  if (partial(d)) return "day-partial";
  return d.start < answer.firstAt ? "day-rebuilt" : "day-read";
}

/** A day's hover rows: what was read and what reconstructed. */
function dayRows(d) {
  const read = d.burn - d.reconstructed;
  if (d.start + DAY <= answer.firstAt)
    return [{ label: "Pool burn, reconstructed", value: d.burn, colour: "var(--s0)" }];
  if (d.start >= answer.firstAt) return [{ label: "Pool burn", value: d.burn, colour: "var(--s0)" }];
  return [
    { label: `Reconstructed, to ${clockName(answer.firstAt)}`, value: d.reconstructed, colour: "var(--s0)" },
    { label: "Read, after", value: read, colour: "var(--s0)" },
  ];
}

/** The hover card's last line: against the refill, or whose share a partial day is missing. */
function dayFoot(d, refill) {
  if (partial(d)) {
    const who = d.missing.map((e) => answer.accounts.find((a) => a.email === e)?.label ?? e);
    return ["Partial", `no curve for ${who.join(", ")} (no limit hit that week): not averaged`];
  }
  const over = d.burn - refill;
  return ["vs. refill", `${over > 0 ? "+" : ""}${Math.round(over)} pts`];
}

function barsHover(svg, shown, plotW, plotH, refill) {
  const bw = plotW / shown.length;
  const layer = el(
    "rect",
    { x: M.l, y: M.t, width: plotW, height: plotH, fill: "transparent" },
    svg,
  );
  layer.addEventListener("mousemove", (event) => {
    const k = Math.min(shown.length - 1, Math.max(0, Math.floor((event.offsetX - M.l) / bw)));
    const day = shown[k];
    const today = k === shown.length - 1;
    const kind = partial(day) ? " · partial" : day.start < answer.firstAt ? " · reconstructed" : "";
    showTip(
      event,
      `${dayName(day.start)}${today ? ` · so far, to ${clockName(answer.now)} CET` : ""}${kind}`,
      dayRows(day),
      dayFoot(day, refill),
      (v) => `${pct(v)} of one account`,
    );
  });
  layer.addEventListener("mouseleave", hideTip);
}

function drawBars() {
  const host = $("fc-bars");
  host.replaceChildren();
  const n = needed();
  const shown = answer.daily.slice(-(choices.days + 1));
  const refill = (answer.accounts.length * 100) / 7;
  barsKey(refill, n, shown);
  if (shown.length === 0) {
    host.innerHTML = `<div class="empty">${NO_READINGS}</div>`;
    return;
  }
  const width = Math.max(host.clientWidth, 300);
  const height = Math.max(host.clientHeight, 120);
  const plotW = width - M.l - M.r;
  const plotH = height - M.t - M.b;
  const top = niceMax(Math.max(...shown.map((d) => d.burn), refill, n?.avg ?? 0));
  const y = (v) => M.t + plotH - (v / top) * plotH;
  const svg = el("svg", { width, height, role: "img" }, host);
  svg.setAttribute("aria-label", "Pool burn per day");
  const pattern = el(
    "pattern",
    {
      id: "fc-today",
      width: 6,
      height: 6,
      patternUnits: "userSpaceOnUse",
      patternTransform: "rotate(45)",
    },
    el("defs", {}, svg),
  );
  el("rect", { width: 6, height: 6, fill: "var(--s0)", "fill-opacity": 0.18 }, pattern);
  el("line", { x1: 0, x2: 0, y1: 0, y2: 6, stroke: "var(--s0)", "stroke-width": 3 }, pattern);
  for (let k = 0; k <= 4; k++) {
    const v = (top * k) / 4;
    el("line", { x1: M.l, x2: width - M.r, y1: y(v), y2: y(v), class: "grid" }, svg);
    el("text", { x: M.l - 6, y: y(v) + 4, "text-anchor": "end" }, svg).textContent = `${v}%`;
  }
  const bw = plotW / shown.length;
  shown.forEach((d, k) => {
    const today = k === shown.length - 1;
    // A day with no burn still shows as a sliver on the axis, so it reads as 0, not as missing.
    const tall = Math.max(2, y(0) - y(d.burn));
    const bar = {
      x: M.l + k * bw + 3,
      y: y(0) - tall,
      width: Math.max(1, bw - 6),
      height: tall,
      rx: 1,
    };
    el("rect", { ...bar, class: barClass(d, today) }, svg);
    if (today) {
      const since = partial(d) ? "so far, partial" : "so far";
      el(
        "text",
        { x: M.l + (k + 0.5) * bw, y: bar.y - 6, "text-anchor": "middle", class: "halo" },
        svg,
      ).textContent = `${pct(d.burn)} ${since}`;
    }
    const label = today ? "today" : dayName(d.start).replace(/ \S+$/, "");
    el(
      "text",
      { x: M.l + (k + 0.5) * bw, y: height - 6, "text-anchor": "middle" },
      svg,
    ).textContent = label;
  });
  el("line", { x1: M.l, x2: width - M.r, y1: y(0), y2: y(0), class: "axis" }, svg);
  el("line", { x1: M.l, x2: width - M.r, y1: y(refill), y2: y(refill), class: "limit" }, svg);
  if (n !== null)
    el("line", { x1: M.l, x2: width - M.r, y1: y(n.avg), y2: y(n.avg), class: "avg" }, svg);
  barsHover(svg, shown, plotW, plotH, refill);
}

// ---- Loading and drawing ----

function statusLine() {
  if (!answer.supported) return TOO_OLD;
  if (answer.newestAt === null) return NO_READINGS;
  const n = answer.accounts.length;
  return `Readings of ${n} account${n === 1 ? "" : "s"} every 5 min · last ${clockName(answer.newestAt)} CET`;
}

/** The accounts-needed panel: again when the days it averages change. */
function drawNeeded() {
  if (answer === null || !answer.supported) return;
  drawTiles();
  drawBars();
}

export function drawForecast() {
  if (answer === null) return;
  const on = document.body.classList.contains("forecast-on");
  if (on) $("status").textContent = statusLine();
  $("fc-empty").hidden = answer.supported && answer.accounts.length > 0;
  $("fc-body").hidden = !$("fc-empty").hidden;
  $("fc-empty").textContent = answer.supported ? "prifly holds no Claude accounts." : TOO_OLD;
  if (!answer.supported || answer.accounts.length === 0) return;
  drawRunway();
  const colours = answer.accounts.map((_, i) => colourOf(i));
  drawBurndown($("fc-burn"), $("fc-burn-legend"), answer, colours, choices.mode);
  $("fc-burn-note").textContent = burndownNote(choices.mode, answer);
  $("fc-burn-span").textContent = burndownSpan(answer);
  drawNeeded();
}

let asked = 0;
export async function loadForecast() {
  const mine = ++asked;
  const tz = String(-new Date().getTimezoneOffset());
  const response = await fetch(`api/forecast?${new URLSearchParams({ tz })}`);
  const got = await response.json();
  if (mine !== asked) return;
  if (!response.ok) {
    $("fc-empty").hidden = false;
    $("fc-body").hidden = true;
    $("fc-empty").textContent = got.error ?? response.statusText;
    return;
  }
  answer = got;
  drawForecast();
}

/** The panels' own toggles, built with the page's `segmented` (app.js), which saves them. */
export function forecastControls(segmented) {
  const modes = [
    ["accounts", "Per account"],
    ["pool", "Whole pool"],
  ];
  segmented(
    "fc-mode",
    modes,
    () => choices.mode,
    (v) => {
      choices.mode = v;
      drawForecast();
    },
  );
  const days = [
    [7, "7 days"],
    [14, "14 days"],
  ];
  segmented(
    "fc-days",
    days,
    () => choices.days,
    (v) => {
      choices.days = v;
      drawNeeded();
    },
  );
}

/** Restore the saved choices and follow the headroom slider; `changed` saves them. */
export function initForecast(saved, changed) {
  if (saved?.mode === "accounts" || saved?.mode === "pool") choices.mode = saved.mode;
  if (saved?.days === 7 || saved?.days === 14) choices.days = saved.days;
  if (Number.isFinite(saved?.headroom)) choices.headroom = saved.headroom;
  const slider = $("fc-headroom");
  slider.value = String(choices.headroom);
  slider.addEventListener("input", () => {
    choices.headroom = Number(slider.value);
    if (answer?.supported) drawTiles();
    changed();
  });
}
