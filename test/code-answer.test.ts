import { expect, test } from "bun:test";
import { Answerer, readParams } from "../answer";
import { type CodeParams, codeAnswer } from "../code-answer";
import type { Commit } from "../git";
import type { LinesSource } from "../git-cache";
import type { Usage } from "../parse";
import { buildColumns } from "../store";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const DAY0 = Date.parse("2026-09-20T00:00:00Z");

const call = (ts: number): Usage => ({
  ts,
  account: "a@x.com",
  model: "claude-opus-5-5",
  cwd: "/x",
  input: 1000,
  cacheWrite: 0,
  cacheRead: 9000,
  output: 10_000,
});
/** What one call above costs: 1000 input at $4/M, 9000 cache reads at $0.20/M, 10000 output at $20/M. */
const COST = (4000 + 1800 + 200_000) / 1e6;

/** alpha spends on days 0 and 1, beta on day 1, cloud (no checkout) on day 2; gamma has lines, no spend. */
const answerer = new Answerer(
  buildColumns([
    {
      sessionId: "s1",
      title: "",
      source: "local",
      repo: "alpha",
      usages: [call(DAY0 + 10 * HOUR), call(DAY0 + DAY + 10 * HOUR)],
    },
    {
      sessionId: "s2",
      title: "",
      source: "local",
      repo: "beta",
      usages: [call(DAY0 + DAY + 11 * HOUR)],
    },
    {
      sessionId: "s3",
      title: "",
      source: "remote",
      repo: "cloud",
      usages: [call(DAY0 + 2 * DAY + 10 * HOUR)],
    },
  ]),
);

const commits: Record<string, Commit[]> = {
  alpha: [
    [DAY0 + HOUR, 100],
    [DAY0 + DAY + HOUR, 300],
  ],
  beta: [[DAY0 + DAY + 12 * HOUR, 50]],
  gamma: [[DAY0 + 2 * DAY + HOUR, 10]],
};
const git = (ready = true): LinesSource => ({
  lines: (name) => commits[name] ?? null,
  names: () => Object.keys(commits),
  ready: () => ready,
});

function ask(extra: Partial<CodeParams> = {}, source = git()) {
  const base = readParams(
    { from: String(DAY0), to: String(DAY0 + 3 * DAY), bucket: String(DAY), tz: "0" },
    DAY0 + 3 * DAY,
  );
  return codeAnswer(answerer, source, { ...base, repo: null, byRepo: false, ...extra });
}

const close = (actual: number | null | undefined, expected: number) =>
  expect(actual ?? Number.NaN).toBeCloseTo(expected, 9);

test("spend and lines share the buckets, one total line each", () => {
  const a = ask();
  expect(a.buckets).toEqual([DAY0, DAY0 + DAY, DAY0 + 2 * DAY]);
  expect(a.cost.length).toBe(1);
  expect(a.lines.length).toBe(1);
  expect(a.cost[0]?.key).toBe("all");
  const spend = a.cost[0]?.values ?? [];
  close(spend[0], COST);
  close(spend[1], 2 * COST);
  close(spend[2], COST);
  expect(a.lines[0]?.values).toEqual([100, 350, 10]);
  expect(a.ready).toBe(true);
});

test("each repository's spend, lines, dollars per 1,000 lines and shares", () => {
  const a = ask();
  expect(a.rows.map((r) => r.key)).toEqual(["alpha", "beta", "cloud", "gamma"]);
  const [alpha, beta, cloud, gamma] = a.rows;
  close(alpha?.spend, 2 * COST);
  expect(alpha?.lines).toBe(400);
  close(alpha?.perK, ((2 * COST) / 400) * 1000);
  close(alpha?.shareSpend, 0.5);
  close(alpha?.shareLines, 400 / 460);
  expect(beta?.lines).toBe(50);
  close(beta?.perK, (COST / 50) * 1000);
  // A repository with spend and no checkout: no lines, not zero.
  close(cloud?.spend, COST);
  expect(cloud?.lines).toBeNull();
  expect(cloud?.perK).toBeNull();
  expect(cloud?.shareLines).toBeNull();
  // Lines and no spend.
  expect(gamma?.spend).toBe(0);
  expect(gamma?.lines).toBe(10);
  expect(gamma?.perK).toBe(0);
  expect(a.repos.sort()).toEqual(["alpha", "beta", "cloud", "gamma"]);
});

test("the totals count dollars per 1,000 lines over the spend that has lines", () => {
  const a = ask();
  close(a.totals.spend, 4 * COST);
  expect(a.totals.lines).toBe(460);
  // The cloud-only repository's spend is left out of the ratio: it has no lines to divide by.
  close(a.totals.perK, ((3 * COST) / 460) * 1000);
  const alpha = ask({ repo: "alpha" });
  close(alpha.totals.spend, 2 * COST);
  expect(alpha.totals.lines).toBe(400);
  expect(alpha.lines[0]?.values).toEqual([100, 300, 0]);
  // The table still shows every repository, to compare with.
  expect(alpha.rows.length).toBe(4);
  const cloud = ask({ repo: "cloud" });
  expect(cloud.totals.lines).toBe(0);
  expect(cloud.totals.perK).toBeNull();
});

test("split by repository gives both charts the same series in the same order", () => {
  const a = ask({ byRepo: true, top: 10 });
  const keys = ["alpha", "beta", "cloud", "gamma"];
  expect(a.cost.map((s) => s.key)).toEqual(keys);
  expect(a.lines.map((s) => s.key)).toEqual(keys);
  expect(a.lines.map((s) => s.total)).toEqual([400, 50, 0, 10]);
  const top2 = ask({ byRepo: true, top: 2 });
  expect(top2.cost.map((s) => s.label)).toEqual(["alpha", "beta", "2 more"]);
  expect(top2.lines.at(-1)?.values).toEqual([0, 0, 10]);
  close(top2.cost.at(-1)?.total, COST);
});

test("a commit lands in the bucket of the reader's own day", () => {
  const late: Record<string, Commit[]> = { alpha: [[DAY0 + DAY + 22.5 * HOUR, 7]] };
  const source: LinesSource = {
    lines: (n) => late[n] ?? null,
    names: () => ["alpha"],
    ready: () => true,
  };
  // UTC+2: 22:30 UTC on day 1 is 00:30 on day 2.
  const a = ask({ tz: 120, from: DAY0 - 2 * HOUR }, source);
  const at = a.buckets.findIndex((b) => b === DAY0 + 2 * DAY - 2 * HOUR);
  expect(a.lines[0]?.values[at]).toBe(7);
  expect(a.lines[0]?.values.reduce((x, y) => x + y, 0)).toBe(7);
  expect(ask({}, source).lines[0]?.values).toEqual([0, 7, 0]);
});

test("an answer before git has been read says so", () => {
  expect(ask({}, git(false)).ready).toBe(false);
});
