import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitLines } from "../git-cache";
import { stampOf } from "../git-stamp";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "token-stats-stamp-"));
  dirs.push(dir);
  return dir;
}

function git(dir: string, ...args: string[]): string {
  const ran = Bun.spawnSync(
    ["git", "-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...args],
    { env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } },
  );
  if (ran.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${ran.stderr.toString()}`);
  return ran.stdout.toString();
}

function commit(dir: string, file: string) {
  writeFileSync(join(dir, file), "const a = 1;\nconst b = 2;\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", file);
}

/** Every file under `dir` last touched 10 s ago: what a checkout nobody has touched for a while looks like. */
function age(dir: string) {
  const old = new Date(Date.now() - 10_000);
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(entry.parentPath, entry.name);
    if (entry.isDirectory()) age(path);
    else utimesSync(path, old, old);
  }
}

function repo(): string {
  const dir = tempDir();
  git(dir, "init", "-q", "-b", "master");
  commit(dir, "a.ts");
  age(join(dir, ".git"));
  return dir;
}

/** The git processes started while `run` runs. */
async function spawned(run: () => Promise<void>): Promise<number> {
  const real = Bun.spawn;
  let count = 0;
  const spy = spyOn(Bun, "spawn").mockImplementation(((...args: Parameters<typeof Bun.spawn>) => {
    count++;
    return real(...args);
  }) as typeof Bun.spawn);
  try {
    await run();
  } finally {
    spy.mockRestore();
  }
  return count;
}

const noLog = () => {};

test("a second refresh with no ref change runs no git", async () => {
  const dir = repo();
  const cached = new GitLines(join(tempDir(), "git.json"));
  const checkouts = new Map([["r", dir]]);
  expect(await spawned(() => cached.refresh(checkouts, noLog))).toBeGreaterThan(0);
  expect(await spawned(() => cached.refresh(checkouts, noLog))).toBe(0);
  expect(cached.lines("r")?.length).toBe(1);
});

test("a new commit on the default branch is read", async () => {
  const dir = repo();
  const cached = new GitLines(join(tempDir(), "git.json"));
  const checkouts = new Map([["r", dir]]);
  await cached.refresh(checkouts, noLog);
  commit(dir, "b.ts");
  // Just made: within the second where an mtime cannot tell, so it is read whatever.
  expect(await spawned(() => cached.refresh(checkouts, noLog))).toBeGreaterThan(0);
  expect(cached.lines("r")?.length).toBe(2);
  age(join(dir, ".git"));
  await cached.refresh(checkouts, noLog);
  commit(dir, "c.ts");
  age(join(dir, ".git"));
  expect(await spawned(() => cached.refresh(checkouts, noLog))).toBeGreaterThan(0);
  expect(cached.lines("r")?.length).toBe(3);
});

test("a fetch that moves origin is read", async () => {
  const dir = repo();
  git(dir, "update-ref", "refs/remotes/origin/master", "master");
  git(dir, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/master");
  age(join(dir, ".git"));
  const cached = new GitLines(join(tempDir(), "git.json"));
  const checkouts = new Map([["r", dir]]);
  await cached.refresh(checkouts, noLog);
  expect(await spawned(() => cached.refresh(checkouts, noLog))).toBe(0);
  const before = cached.lines("r")?.length;
  writeFileSync(join(dir, "d.ts"), "const d = 1;\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "d");
  git(dir, "update-ref", "refs/remotes/origin/master", "HEAD");
  age(join(dir, ".git"));
  expect(await spawned(() => cached.refresh(checkouts, noLog))).toBeGreaterThan(0);
  expect(cached.lines("r")?.length).toBe((before ?? 0) + 1);
});

test("a linked worktree's fingerprint follows the shared refs", () => {
  const dir = repo();
  const linked = join(tempDir(), "linked");
  git(dir, "worktree", "add", "-q", "-b", "side", linked);
  age(join(dir, ".git"));
  age(linked);
  const first = stampOf(linked, "master");
  expect(first).not.toBeNull();
  expect(stampOf(linked, "master")).toBe(first);
  mkdirSync(join(dir, ".git", "refs", "heads"), { recursive: true });
  writeFileSync(join(dir, ".git", "packed-refs"), "# pack-refs\n");
  const old = new Date(Date.now() - 5_000);
  utimesSync(join(dir, ".git", "packed-refs"), old, old);
  expect(stampOf(linked, "master")).not.toBe(first);
});

test("a file changed within the last second gives no fingerprint", () => {
  const dir = repo();
  expect(stampOf(dir, "master")).not.toBeNull();
  writeFileSync(join(dir, ".git", "FETCH_HEAD"), "x\n");
  expect(stampOf(dir, "master")).toBeNull();
});
