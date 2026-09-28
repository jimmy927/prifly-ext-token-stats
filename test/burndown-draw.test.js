import { expect, test } from "bun:test";
import { drawBurndown } from "../panel/burndown.js";
import { clockName, dayName } from "../panel/format.js";

/** Just enough of the DOM for the burn-down to draw into: nodes in the order drawn. */
class FakeNode {
  constructor(tag) {
    this.tag = tag;
    this.attrs = {};
    this.children = [];
    this.parent = null;
    this.textContent = "";
    this.clientWidth = 1200;
    this.clientHeight = 320;
  }
  setAttribute(k, v) {
    this.attrs[k] = String(v);
  }
  appendChild(child) {
    child.parent = this;
    this.children.push(child);
    return child;
  }
  remove() {
    this.parent.children = this.parent.children.filter((c) => c !== this);
  }
  replaceChildren() {
    this.children = [];
  }
  addEventListener() {}
  getComputedTextLength() {
    return this.textContent.length * 6;
  }
  querySelectorAll() {
    return [];
  }
}
globalThis.document = {
  createElementNS: (_, tag) => new FakeNode(tag),
  getElementById: () => null,
};

const H = 3_600_000;
const DAY = 24 * H;
/** The first reading as on 28 Sep 2026: 03:32:04 CET. */
const FIRST = 1790559124399;
const now = FIRST + 8 * 60_000;
const gridFrom = Math.floor(FIRST / H) * H;
const pastFrom = Math.floor((now - 7 * DAY) / H) * H;

function answerWith(curves, pool = []) {
  const account = (email) => ({
    email,
    label: email,
    measured: [[FIRST, 60]],
    forecast: [],
    hourly: [60, 60],
  });
  return {
    now,
    firstAt: FIRST,
    grid: { from: gridFrom, step: H, pool: [140, 140] },
    accounts: [account("a"), account("b")],
    pool: { measured: [[FIRST, 80]], forecast: [] },
    history: {
      from: pastFrom,
      windows: [
        {
          email: "a",
          start: now - 6 * DAY,
          end: now + DAY,
          hitAt: now - 4 * DAY,
          refusals: 1,
          lastRefusalAt: now - 4 * DAY,
        },
      ],
      unplaced: 0,
    },
    past: {
      curves,
      per100: 2400,
      band: 0.3,
      pool,
      hourly: {
        from: pastFrom,
        step: H,
        byAccount: [[], []],
        range: [[], []],
        pool: [],
        poolRange: [],
      },
    },
  };
}

function draw(answer, mode = "accounts", legend = new FakeNode("div")) {
  const host = new FakeNode("div");
  drawBurndown(host, legend, answer, ["red", "blue"], mode);
  return host.children[0].children;
}

test("the hatching says when readings began, drawn over the grid so no line cuts its date", () => {
  const nodes = draw(answerWith([]));
  const k = nodes.findIndex((n) => n.textContent.startsWith("readings began"));
  expect(nodes[k].textContent).toBe(`readings began ${dayName(FIRST)} ${clockName(FIRST)}`);
  expect(nodes[k].textContent).toContain("28");
  // A midnight line in the grid colour drawn over "28 Sept" erased the 8's left half: "23 Sept".
  const grid = nodes.map((n, i) => (n.attrs.class === "grid" ? i : -1)).filter((i) => i >= 0);
  expect(grid.length).toBeGreaterThan(0);
  for (const i of grid) expect(i).toBeLessThan(k);
});

test("a reconstructed curve is drawn dotted and only uncovered stretches stay hatched", () => {
  const hit = now - 4 * DAY;
  const curve = (email) => ({
    email,
    start: now - 6 * DAY,
    end: now + DAY,
    anchor: "hit",
    points: [
      [now - 6 * DAY, 0],
      [hit, 100],
      [FIRST, 100],
    ],
  });
  const hatched = (nodes) => nodes.filter((n) => n.attrs.class === "before");
  // Only a has a curve: b has no %, so the whole stretch before the readings stays hatched.
  const one = draw(answerWith([curve("a")]));
  expect(one.filter((n) => n.attrs.class === "reconstructed")).toHaveLength(1);
  expect(hatched(one)).toHaveLength(1);
  // Both do: hatched only before their windows began, and it no longer ends at the first reading.
  const both = draw(answerWith([curve("a"), curve("b")]));
  const dotted = both.filter((n) => n.attrs.class === "reconstructed");
  expect(dotted).toHaveLength(2);
  expect(dotted[0].attrs["stroke-dasharray"]).toBe("1 3");
  expect(hatched(both)).toHaveLength(1);
  expect(both.some((n) => n.textContent.startsWith("readings began"))).toBe(false);
});

test("each account burns down: % left from 100 at its reset to 0 where it ran out", () => {
  const hit = now - 4 * DAY;
  const curve = {
    email: "a",
    start: now - 6 * DAY,
    end: now + DAY,
    anchor: "hit",
    points: [
      [now - 6 * DAY, 0],
      [hit, 100],
      [FIRST, 100],
    ],
  };
  const nodes = draw(answerWith([curve]));
  // 320 high less the two lanes: the plot runs from y 16 (100% left) to 274 (0% left).
  const y = (left) => 16 + 258 - (left / 100) * 258;
  const limit = nodes.find((n) => n.attrs.class === "limit");
  expect(Number(limit.attrs.y1)).toBeCloseTo(y(0), 6);
  expect(nodes.find((n) => n.attrs.class === "limit-label halo").textContent).toBe("empty");
  // The reconstructed curve starts full and ends empty.
  const path = nodes.find((n) => n.attrs.class === "reconstructed").attrs.d;
  expect(path.startsWith("M")).toBe(true);
  const ys = [...path.matchAll(/[ML][\d.]+ ([\d.]+)/g)].map((m) => Number(m[1]));
  expect(ys[0]).toBeCloseTo(y(100), 0);
  expect(ys.at(-1)).toBeCloseTo(y(0), 0);
  // The one reading at 60% used is a dot at 40% left.
  const read = nodes.find((n) => n.tag === "circle" && n.attrs.fill === "red" && !n.attrs.class);
  expect(Number(read.attrs.cy)).toBeCloseTo(y(40), 6);
  // Where it ran out, a dot on the empty line.
  const out = nodes.filter((n) => n.attrs.class === "hit" && Number(n.attrs.cy) === y(0));
  expect(out).toHaveLength(1);
  // The pool is already what is left: its reading of 80 sits at 80 of 200.
  const pool = draw(answerWith([curve]), "pool");
  const dot = pool.find((n) => n.tag === "circle" && n.attrs.fill === "var(--fg)");
  expect(Number(dot.attrs.cy)).toBeCloseTo(16 + 258 - (80 / 200) * 258, 6);
  expect(pool.find((n) => n.attrs.class === "limit-label halo").textContent).toBe("pool empty");
});

test("a window that never ran out is estimated: dash-dotted in its band, unhatched, in the legend", () => {
  const start = now - 6 * DAY;
  const hit = {
    email: "a",
    start,
    end: now + DAY,
    anchor: "hit",
    points: [
      [start, 0],
      [now - 4 * DAY, 100],
      [FIRST, 100],
    ],
  };
  const guess = {
    email: "b",
    start,
    end: FIRST,
    anchor: "estimate",
    points: [
      [start, 0],
      [FIRST, 40],
    ],
    band: [
      [start, 0, 0],
      [FIRST, 28, 52],
    ],
  };
  const legend = new FakeNode("div");
  const nodes = draw(answerWith([hit, guess]), "accounts", legend);
  const est = nodes.filter((n) => n.attrs.class === "estimated");
  expect(est).toHaveLength(1);
  expect(est[0].attrs.stroke).toBe("blue");
  expect(est[0].attrs["stroke-dasharray"]).toBe("7 2 1 2");
  const band = nodes.filter((n) => n.attrs.class === "band");
  expect(band).toHaveLength(1);
  expect(band[0].attrs.fill).toBe("blue");
  expect(band[0].attrs.d.endsWith("Z")).toBe(true);
  // Both accounts have a line from the window's start: hatched only before it, none left to say "never ran out".
  expect(nodes.filter((n) => n.attrs.class === "before")).toHaveLength(1);
  expect(nodes.some((n) => n.textContent.includes("never ran out"))).toBe(false);
  expect(legend.innerHTML).toContain("estimated ±30%");
  expect(legend.innerHTML).toContain("leave-one-out error 29% RMS");
  expect(legend.innerHTML).toContain("reconstructed");
  // The pool: estimated (band and dash-dot) while b's share is, dotted once every share is reconstructed.
  const run = {
    points: [
      [start, 200],
      [start + DAY, 150],
      [start + 2 * DAY, 100],
      [start + 3 * DAY, 90],
    ],
    range: [
      [200, 200],
      [140, 160],
      [100, 100],
      [90, 90],
    ],
    estimated: [true, true, false, false],
  };
  const pool = draw(answerWith([hit, guess], [run]), "pool");
  const kinds = pool
    .filter((n) => ["estimated", "reconstructed", "band"].includes(n.attrs.class))
    .map((n) => n.attrs.class);
  expect(kinds).toEqual(["band", "estimated", "reconstructed"]);
});
