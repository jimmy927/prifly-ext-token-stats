import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Answerer, readParams } from "../answer";
import {
  applyScan,
  decodeArchive,
  encodeArchive,
  type FileOut,
  loadArchive,
  saveArchive,
  settleArchive,
} from "../archive";
import type { Usage } from "../parse";
import type { ScanReply, ScanRequest } from "../scan-worker";
import { buildColumns } from "../store";

const usage = (ts: number, output: number): Usage => ({
  ts,
  account: "a@x.com",
  model: "claude-opus-5-5",
  cwd: "/tmp/x",
  input: 1,
  cacheWrite: 2,
  cacheRead: 3,
  output,
});

const file = (path: string, output: number): FileOut => ({
  path,
  sessionId: path.slice(path.lastIndexOf("/") + 1, -6),
  parentId: null,
  title: "t",
  usages: [usage(Date.parse("2026-09-01T00:00:00Z"), output)],
});

/** All output tokens the panel would show, over all history. */
function totalOutput(live: Map<string, FileOut>, archive: Map<string, FileOut>): number {
  const batches = [...live.values(), ...archive.values()].map((f) => ({
    sessionId: f.sessionId,
    title: f.title,
    source: "local" as const,
    repo: "r",
    usages: f.usages,
  }));
  const answer = new Answerer(buildColumns(batches)).answer(
    readParams(
      {
        from: "0",
        to: String(Date.parse("2027-01-01")),
        split: "source",
        bucket: "86400000",
        metric: "output",
      },
      0,
    ),
  );
  return answer.series.reduce((sum, series) => sum + series.total, 0);
}

const none = { files: [], removed: [], archived: [], reclaimed: [] };

test("the archive keeps every field through its compact form", () => {
  const files = [
    file("/p/a.jsonl", 5),
    { ...file("/p/s/subagents/b.jsonl", 7), parentId: "s", writes: { odi: 3, prifly: 1 } },
    // Refusals with no writes, and with them.
    { ...file("/p/c.jsonl", 1), hits: [{ ts: 5, account: "a@x.com", resetsAt: 9 }] },
    {
      ...file("/p/d.jsonl", 2),
      writes: { odi: 1 },
      hits: [{ ts: 6, account: "b@x.com", resetsAt: 10 }],
    },
  ];
  const json = JSON.parse(JSON.stringify(encodeArchive(files)));
  expect(json.strings).toEqual(["a@x.com", "claude-opus-5-5", "/tmp/x", "b@x.com"]);
  expect(decodeArchive(json)).toEqual(files);
  expect(decodeArchive({ version: 99, strings: [], files: [] })).toBeNull();
  expect(decodeArchive({ version: 1, strings: [], files: [7] })).toBeNull();
});

test("a transcript deleted between two scans keeps its usages in the answer", () => {
  const live = new Map<string, FileOut>();
  const archive = new Map<string, FileOut>();
  const a = file("/p/a.jsonl", 5);
  const b = file("/p/b.jsonl", 7);
  applyScan(live, archive, { ...none, files: [a, b] });
  expect(totalOutput(live, archive)).toBe(12);
  // The worker's side: b left the disk.
  const kept = new Map<string, FileOut>();
  const settled = settleArchive(kept, [b], new Set([a.path]));
  expect(settled.archived).toEqual([b]);
  expect(applyScan(live, archive, { ...none, removed: [b.path], ...settled })).toBe(true);
  expect([live.size, archive.size]).toEqual([1, 1]);
  expect(totalOutput(live, archive)).toBe(12);
});

test("a file that reappears at its path is counted once, from the live file", () => {
  const worker = new Map([["/p/b.jsonl", file("/p/b.jsonl", 7)]]);
  const settled = settleArchive(worker, [], new Set(["/p/b.jsonl"]));
  expect(settled.reclaimed).toEqual(["/p/b.jsonl"]);
  expect(worker.size).toBe(0);
  const live = new Map<string, FileOut>();
  const archive = new Map([["/p/b.jsonl", file("/p/b.jsonl", 7)]]);
  applyScan(live, archive, { ...none, files: [file("/p/b.jsonl", 9)], ...settled });
  expect(archive.size).toBe(0);
  expect(totalOutput(live, archive)).toBe(9);
});

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "token-stats-"));
  dirs.push(dir);
  return dir;
};

test("an archive that cannot be read is moved aside, never overwritten", async () => {
  const dir = tempDir();
  const path = join(dir, "archive.json");
  writeFileSync(path, "{ not json");
  expect(await loadArchive(path)).toEqual([]);
  expect(existsSync(path)).toBe(false);
  expect(readdirSync(dir).some((name) => name.startsWith("archive.json.unreadable-"))).toBe(true);
  await saveArchive(path, [file("/p/a.jsonl", 5)]);
  expect(await loadArchive(path)).toEqual([file("/p/a.jsonl", 5)]);
});

const line = (id: string, output: number) =>
  JSON.stringify({
    type: "assistant",
    timestamp: "2026-09-01T00:00:00Z",
    requestId: `r${id}`,
    cwd: "/tmp/x",
    message: { id, model: "claude-opus-5-5", usage: { input_tokens: 1, output_tokens: output } },
  });

function scanWith(worker: Worker, request: ScanRequest): Promise<ScanReply> {
  return new Promise((resolve) => {
    worker.onmessage = (event: MessageEvent<ScanReply>) => resolve(event.data);
    worker.postMessage(request);
  });
}

test("the worker archives a deleted transcript, keeps it without the live cache, and reclaims it", async () => {
  const dir = tempDir();
  const root = join(dir, "projects");
  mkdirSync(join(root, "proj"), { recursive: true });
  const a = join(root, "proj", "a.jsonl");
  const b = join(root, "proj", "b.jsonl");
  writeFileSync(a, `${line("m1", 5)}\n`);
  writeFileSync(b, `${line("m2", 7)}\n`);
  const request: ScanRequest = {
    type: "scan",
    root,
    cacheFile: join(dir, "cache", "local.sqlite"),
    legacyCacheFile: join(dir, "cache", "local.json"),
    archiveFile: join(dir, "cache", "archive.json"),
  };
  const live = new Map<string, FileOut>();
  const archive = new Map<string, FileOut>();
  const url = new URL("../scan-worker.ts", import.meta.url).href;

  const first = new Worker(url);
  applyScan(live, archive, await scanWith(first, request));
  rmSync(b);
  const second = await scanWith(first, request);
  expect(second.archived.map((f) => f.path)).toEqual([b]);
  applyScan(live, archive, second);
  expect(totalOutput(live, archive)).toBe(12);
  first.terminate();

  // A reset live cache: a fresh worker still sends the archive in its first reply.
  rmSync(request.cacheFile);
  live.clear();
  archive.clear();
  const again = new Worker(url);
  applyScan(live, archive, await scanWith(again, request));
  expect([live.size, archive.size]).toEqual([1, 1]);
  expect(totalOutput(live, archive)).toBe(12);

  writeFileSync(b, `${line("m2", 7)}\n`);
  const back = await scanWith(again, request);
  expect(back.reclaimed).toEqual([b]);
  applyScan(live, archive, back);
  expect([live.size, archive.size]).toEqual([2, 0]);
  expect(totalOutput(live, archive)).toBe(12);
  again.terminate();
});
