import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FileState, LocalCache } from "../local-cache";
import { freshState, type Usage } from "../parse";
import type { FileOut, ScanReply, ScanRequest } from "../scan-worker";

const dirs: string[] = [];
const open: LocalCache[] = [];
afterEach(() => {
  for (const cache of open.splice(0)) cache.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "token-stats-cache-"));
  dirs.push(dir);
  return dir;
};
const cacheIn = (dir: string, version = 2) => {
  const cache = new LocalCache(join(dir, "local.sqlite"), version);
  open.push(cache);
  return cache;
};

const usage = (ts: number): Usage => ({
  ts,
  account: "a@x.com",
  model: "claude-opus-5-5",
  cwd: "/tmp/x",
  input: 1,
  cacheWrite: 2,
  cacheWrite1h: 0,
  cacheRead: 3,
  output: 4,
});

const state = (path: string, calls: number): FileState => ({
  path,
  sessionId: path.slice(path.lastIndexOf("/") + 1, -6),
  parentId: null,
  title: "t",
  usages: Array.from({ length: calls }, (_, i) => usage(i)),
  size: calls * 100,
  mtime: calls,
  offset: calls * 100,
  reader: { ...freshState("a@x.com"), recent: ["m/r"] },
});

const chunkCount = (dir: string) => {
  const db = new Database(join(dir, "local.sqlite"), { readonly: true });
  const row = db.query<{ n: number }, []>("SELECT count(*) AS n FROM chunks").get();
  db.close();
  return row?.n;
};

test("a save writes only the files that changed, and a reload sees them whole", () => {
  const dir = tempDir();
  const cache = cacheIn(dir);
  expect(cache.load(join(dir, "none.json"))).toEqual([]);
  const files = new Map([
    ["/p/a.jsonl", state("/p/a.jsonl", 3)],
    ["/p/b.jsonl", state("/p/b.jsonl", 2)],
  ]);
  expect(cache.save(files)).toBe(4);
  expect(cache.save(files)).toBe(0);
  const a = files.get("/p/a.jsonl") as FileState;
  a.usages.push(usage(10), usage(11));
  a.size = a.offset = 500;
  a.mtime = 5;
  // One file row and one chunk of its two new calls.
  expect(cache.save(files)).toBe(2);
  expect(chunkCount(dir)).toBe(3);
  cache.close();
  open.pop();
  expect(cacheIn(dir).load("")).toEqual([...files.values()]);
});

test("a file read again from the start drops its old calls; a file gone drops its rows", () => {
  const dir = tempDir();
  const cache = cacheIn(dir);
  cache.load("");
  const files = new Map([
    ["/p/a.jsonl", state("/p/a.jsonl", 3)],
    ["/p/b.jsonl", state("/p/b.jsonl", 2)],
  ]);
  cache.save(files);
  // The scan's reset: a new state object for the same path, fewer bytes in.
  files.set("/p/a.jsonl", state("/p/a.jsonl", 1));
  files.delete("/p/b.jsonl");
  expect(cache.save(files)).toBe(3);
  expect(chunkCount(dir)).toBe(1);
  expect(cacheIn(dir).load("")).toEqual([state("/p/a.jsonl", 1)]);
});

test("the old JSON cache is imported once into a new database and left in place", () => {
  const dir = tempDir();
  const legacy = join(dir, "local.json");
  const files = [state("/p/a.jsonl", 3), state("/p/b.jsonl", 0)];
  writeFileSync(legacy, JSON.stringify({ version: 2, files }));
  expect(cacheIn(dir).load(legacy)).toEqual(files);
  expect(existsSync(legacy)).toBe(true);
  // Emptied by the scan afterwards, it is not imported again.
  const cache = cacheIn(dir);
  cache.load(legacy);
  cache.save(new Map());
  expect(cacheIn(dir).load(legacy)).toEqual([]);
});

test("an old JSON cache of another version, or not JSON, is not imported", () => {
  const dir = tempDir();
  const legacy = join(dir, "local.json");
  writeFileSync(legacy, JSON.stringify({ version: 1, files: [state("/p/a.jsonl", 3)] }));
  expect(cacheIn(dir).load(legacy)).toEqual([]);
  const other = tempDir();
  writeFileSync(join(other, "local.json"), "{ cut off");
  expect(cacheIn(other).load(join(other, "local.json"))).toEqual([]);
});

test("a database of another version is emptied, not imported into", () => {
  const dir = tempDir();
  const cache = cacheIn(dir, 2);
  cache.load("");
  cache.save(new Map([["/p/a.jsonl", state("/p/a.jsonl", 3)]]));
  const legacy = join(dir, "local.json");
  writeFileSync(legacy, JSON.stringify({ version: 3, files: [state("/p/b.jsonl", 1)] }));
  expect(cacheIn(dir, 3).load(legacy)).toEqual([]);
});

test("a file's calls in many chunks are rewritten as one on load, in order", () => {
  const dir = tempDir();
  const cache = cacheIn(dir);
  cache.load("");
  const a = state("/p/a.jsonl", 0);
  const files = new Map([[a.path, a]]);
  for (let i = 0; i < 40; i += 1) {
    a.usages.push(usage(i));
    a.offset = a.size = i + 1;
    cache.save(files);
  }
  expect(chunkCount(dir)).toBe(40);
  expect(cacheIn(dir).load("")).toEqual([a]);
  expect(chunkCount(dir)).toBe(1);
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

const byPath = (files: FileOut[]) => [...files].sort((x, y) => x.path.localeCompare(y.path));

test("a restarted worker answers from the cache what a fresh read of the transcripts would", async () => {
  const dir = tempDir();
  const root = join(dir, "projects");
  mkdirSync(join(root, "proj", "s", "subagents"), { recursive: true });
  const main = join(root, "proj", "s.jsonl");
  const agent = join(root, "proj", "s", "subagents", "agent-1.jsonl");
  writeFileSync(main, `${line("m1", 5)}\n`);
  writeFileSync(agent, `${line("m2", 7)}\n`);
  const request: ScanRequest = {
    type: "scan",
    root,
    cacheFile: join(dir, "cache", "local.sqlite"),
    legacyCacheFile: join(dir, "cache", "local.json"),
    archiveFile: join(dir, "cache", "archive.json"),
  };
  const url = new URL("../scan-worker.ts", import.meta.url).href;
  const one = new Worker(url);
  await scanWith(one, request);
  appendFileSync(main, `${line("m3", 11)}\n`);
  expect((await scanWith(one, request)).stats.read).toBe(1);
  one.terminate();

  const cached = new Worker(url);
  const restarted = await scanWith(cached, request);
  cached.terminate();
  expect(restarted.stats.bytes).toBe(0);
  const fresh = new Worker(url);
  const reread = await scanWith(fresh, { ...request, cacheFile: join(dir, "other.sqlite") });
  fresh.terminate();
  expect(byPath(restarted.files)).toEqual(byPath(reread.files));
  expect(restarted.files.flatMap((f) => f.usages.map((u) => u.output)).sort()).toEqual([11, 5, 7]);
});
