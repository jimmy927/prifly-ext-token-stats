import { expect, test } from "bun:test";
import { Answerer, readParams } from "../answer";
import type { Usage } from "../parse";
import { clip, simulateWindow } from "../simulate";
import { buildColumns } from "../store";

const call = (model: string, counts: Partial<Usage>, ts = 0): Usage => ({
  ts,
  account: "a@x.com",
  model,
  cwd: "/tmp/x",
  input: 0,
  cacheWrite: 0,
  cacheWrite1h: 0,
  cacheRead: 0,
  output: 0,
  ...counts,
});

const opus = call("claude-opus-5-5", {
  input: 1000,
  cacheWrite: 3000,
  cacheWrite1h: 2000,
  cacheRead: 900_000,
  output: 500,
});
const fable = call("claude-fable-5-1[1m]", { input: 10, cacheRead: 700_000, output: 4000 });

test("a call over the window is cut to it, cache reads first, output kept", () => {
  // C = 1000 + 3000 + 900k = 904k; 504k over a 400k window, all from the cache reads.
  expect(clip(opus, 400_000)).toEqual({
    input: 1000,
    cacheWrite: 3000,
    cacheWrite1h: 2000,
    cacheRead: 396_000,
    output: 500,
  });
  // Reads run out: the rest comes off the writes, their 5-minute part first.
  const big = { input: 1000, cacheWrite: 300_000, cacheWrite1h: 100_000, cacheRead: 50_000 };
  expect(clip({ ...big, output: 7 }, 200_000)).toEqual({
    input: 1000,
    cacheWrite: 199_000,
    cacheWrite1h: 100_000,
    cacheRead: 0,
    output: 7,
  });
  const onlyHour = { input: 0, cacheWrite: 300_000, cacheWrite1h: 300_000, cacheRead: 0 };
  expect(clip({ ...onlyHour, output: 0 }, 200_000).cacheWrite1h).toBe(200_000);
});

test("a call under the window is unchanged", () => {
  expect(clip(fable, 800_000)).toBe(fable);
  expect(clip(fable, 700_010)).toBe(fable);
  expect(clip(fable, 700_009).cacheRead).toBe(699_999);
});

test("hand arithmetic for two models, per window", () => {
  const sim = simulateWindow([opus, fable], [800_000, 400_000]);
  // Opus 5.5 as run: 1000×$4 + 1000×$5 (5m) + 2000×$8 (1h) + 900k×$0.20 + 500×$20 = $0.215.
  // Fable 5.1 as run: 10×$10 + 700k×$0.25 + 4000×$50 = $0.3751.
  expect(sim.actual).toBeCloseTo(0.215 + 0.3751, 10);
  expect(sim.calls).toBe(2);
  expect(sim.largest).toBe(904_000);
  // 800k: Opus reads 796k → $0.1942; Fable's 700,010 fits.
  expect(sim.windows[0]).toEqual({
    window: 800_000,
    cost: expect.closeTo(0.1942 + 0.3751, 10),
    clipped: 1,
  });
  // 400k: Opus reads 396k → $0.1142; Fable reads 399,990 → 100 + 99,997.5 + 200,000 per million.
  expect(sim.windows[1]).toEqual({
    window: 400_000,
    cost: expect.closeTo(0.1142 + 0.3000975, 10),
    clipped: 2,
  });
});

test("an unpriced model is counted apart, never costed", () => {
  const sim = simulateWindow([opus, call("claude-nonesuch-9", { cacheRead: 900_000 })]);
  expect(sim.unpriced).toBe(1);
  expect(sim.calls).toBe(1);
  expect(sim.actual).toBeCloseTo(0.215, 10);
});

test("a smaller window never costs more", () => {
  let seed = 7;
  const rand = (n: number) => {
    seed = (seed * 48_271) % 2_147_483_647;
    return Math.floor((seed / 2_147_483_647) * n);
  };
  const models = ["claude-opus-5-5", "claude-sonnet-4-6", "claude-haiku-4-5", "claude-fable-5"];
  const usages = Array.from({ length: 500 }, (_, k) => {
    const cacheWrite = rand(400_000);
    return call(models[k % models.length] ?? "", {
      input: rand(50_000),
      cacheWrite,
      cacheWrite1h: rand(cacheWrite + 1),
      cacheRead: rand(1_000_000),
      output: rand(30_000),
    });
  });
  const sim = simulateWindow(usages, [1_500_000, 800_000, 600_000, 400_000, 200_000, 1000]);
  expect(sim.windows[0]?.cost).toBeCloseTo(sim.actual, 8);
  let previous = sim.actual;
  for (const { cost } of sim.windows) {
    expect(cost).toBeLessThanOrEqual(previous + 1e-9);
    previous = cost;
  }
});

test("today is the reader's day, follows the filters, and the stretch matches the table", () => {
  const now = Date.parse("2026-09-27T12:00:00Z");
  // Two hours east of UTC: the reader's day began at 22:00 UTC.
  const tz = "120";
  const usages = [
    { ...opus, ts: Date.parse("2026-09-26T21:30:00Z") }, // 23:30 yesterday, local
    { ...opus, ts: Date.parse("2026-09-26T22:30:00Z") }, // 00:30 today, local
    { ...fable, ts: Date.parse("2026-09-27T09:00:00Z") },
  ];
  const cols = buildColumns([{ sessionId: "s", title: "t", source: "local", repo: "r", usages }]);
  const ask = (filters: string) =>
    new Answerer(cols).answer(
      readParams({ from: String(now - 2 * 86_400_000), to: String(now), tz, filters }, now),
      now,
    );
  const all = ask("{}");
  expect(all.simulation.today.calls).toBe(2);
  expect(all.simulation.today.actual).toBeCloseTo(0.215 + 0.3751, 10);
  expect(all.simulation.stretch.calls).toBe(3);
  expect(all.simulation.stretch.actual).toBeCloseTo(all.rows[0]?.cost ?? -1, 10);
  const onlyOpus = ask(JSON.stringify({ model: ["claude-opus-5-5"] }));
  expect(onlyOpus.simulation.today.calls).toBe(1);
  expect(onlyOpus.simulation.today.windows.at(-1)?.clipped).toBe(1);
});
