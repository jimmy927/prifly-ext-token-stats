import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AccountInfo } from "../prifly-api";
import { RETAIN, Readings } from "../readings";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 8, 27, 12);
const dirs: string[] = [];

function fileIn(): string {
  const dir = mkdtempSync(join(tmpdir(), "readings-"));
  dirs.push(dir);
  return join(dir, "cache", "readings.jsonl");
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const account = (readAt: number | null, weekly: number): AccountInfo => ({
  email: "a@x.com",
  label: "Work",
  startsNewSessions: true,
  readAt,
  limits:
    readAt === null
      ? []
      : [
          {
            label: "5h",
            title: "5-hour session",
            usedPercent: 3,
            resetsAt: NOW,
            windowMs: 5 * 3.6e6,
          },
          {
            label: "7d",
            title: "Weekly, all models",
            usedPercent: weekly,
            resetsAt: NOW,
            windowMs: 7 * DAY,
          },
          {
            label: "7F",
            title: "Weekly, Fable only",
            usedPercent: 9,
            resetsAt: NOW,
            windowMs: 7 * DAY,
          },
        ],
});

test("only a newer readAt is appended, one reading per followed limit", () => {
  const file = fileIn();
  const readings = new Readings(file);
  expect(readings.take([account(null, 0)], NOW)).toBe(0);
  expect(readings.take([account(NOW - 1000, 40)], NOW)).toBe(2);
  expect(readings.take([account(NOW - 1000, 40)], NOW)).toBe(0);
  expect(readings.take([account(NOW, 41)], NOW)).toBe(2);
  expect(readings.all().map((r) => [r.label, r.usedPercent])).toEqual([
    ["5h", 3],
    ["7d", 40],
    ["5h", 3],
    ["7d", 41],
  ]);
  expect(readings.newestAt).toBe(NOW);
  expect(readings.accounts).toEqual([
    {
      email: "a@x.com",
      label: "Work",
      startsNewSessions: true,
      windowMs: { "5h": 5 * 3.6e6, "7d": 7 * DAY },
    },
  ]);
  // A second store over the same file has the same readings, and still appends only newer ones.
  const again = new Readings(file);
  again.load(NOW);
  expect(again.all()).toEqual(readings.all());
  expect(again.take([account(NOW, 41)], NOW)).toBe(0);
});

test("readings older than 30 days are dropped on load, and a line cut short is skipped", () => {
  const file = fileIn();
  const first = new Readings(file);
  first.take([account(NOW - RETAIN - DAY, 10)], NOW - RETAIN - DAY);
  first.take([account(NOW - DAY, 20)], NOW - DAY);
  writeFileSync(file, `${readFileSync(file, "utf8")}{"at":`);
  const loaded = new Readings(file);
  loaded.load(NOW);
  expect(loaded.all().map((r) => r.usedPercent)).toEqual([3, 20]);
  expect(readFileSync(file, "utf8").trim().split("\n")).toHaveLength(2);
});

test("a day past the retention, a take rewrites the file without the old readings", () => {
  const file = fileIn();
  const readings = new Readings(file);
  readings.take([account(NOW - RETAIN - 2 * DAY, 10)], NOW - RETAIN - 2 * DAY);
  readings.take([account(NOW, 20)], NOW);
  expect(readings.all().map((r) => r.at)).toEqual([NOW, NOW]);
  expect(readFileSync(file, "utf8").trim().split("\n")).toHaveLength(2);
});
