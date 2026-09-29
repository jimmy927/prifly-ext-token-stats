import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { isCode } from "../code-filter";
import { commitsIn, defaultBranch, parseLog } from "../git";
import { GitLines } from "../git-cache";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "token-stats-git-"));
  dirs.push(dir);
  return dir;
};

/** Run git in `dir`, as `t <t@t>`, at `date` (UTC, `2026-01-02`), throwing on failure. */
function git(dir: string, date: string, ...args: string[]): string {
  const at = `${date}T12:00:00Z`;
  const ran = Bun.spawnSync(
    [
      "git",
      "-C",
      dir,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    {
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: at,
        GIT_COMMITTER_DATE: at,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
      },
    },
  );
  if (ran.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${ran.stderr.toString()}`);
  return ran.stdout.toString();
}

const lines = (n: number, tag = "x") =>
  Array.from({ length: n }, (_, k) => `const ${tag}${k} = ${k};\n`).join("");

function write(dir: string, path: string, text: string | Uint8Array) {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), text);
}

function commit(dir: string, date: string, message: string) {
  git(dir, date, "add", "-A");
  git(dir, date, "commit", "-q", "-m", message);
}

/** The ms of `2026-01-02T12:00:00Z`. */
const at = (date: string) => Date.parse(`${date}T12:00:00Z`);

/**
 * master: c1 (a.ts 6 lines, README.md, bun.lock), c2 (a.ts renamed to b.ts with
 * 2 lines added, a binary file), c4 (d.ts 4 lines, vendor/x.ts 9, vendors/y.ts 2),
 * and the merge of `feature`, whose one commit (c.ts, 7 lines) is older than c4.
 * `wip` has a commit master never merged.
 */
function history(): string {
  const dir = tempDir();
  git(dir, "2026-01-01", "init", "-q", "-b", "master");
  write(dir, "a.ts", lines(6, "a"));
  write(dir, "README.md", lines(10, "r"));
  write(dir, "bun.lock", lines(50, "l"));
  commit(dir, "2026-01-01", "c1");
  git(dir, "2026-01-02", "mv", "a.ts", "b.ts");
  write(dir, "b.ts", lines(6, "a") + lines(2, "extra"));
  write(dir, "blob.bin", new Uint8Array([0, 1, 2, 0, 255, 0]));
  commit(dir, "2026-01-02", "c2");
  git(dir, "2026-01-03", "switch", "-q", "-c", "feature");
  write(dir, "c.ts", lines(7, "c"));
  commit(dir, "2026-01-03", "c3");
  git(dir, "2026-01-04", "switch", "-q", "master");
  write(dir, "d.ts", lines(4, "d"));
  write(dir, "vendor/x.ts", lines(9, "v"));
  write(dir, "src/vendors/y.ts", lines(2, "y"));
  commit(dir, "2026-01-04", "c4");
  git(dir, "2026-01-05", "merge", "-q", "--no-ff", "-m", "merge feature", "feature");
  git(dir, "2026-01-06", "switch", "-q", "-c", "wip");
  write(dir, "wip.ts", lines(5, "w"));
  commit(dir, "2026-01-06", "wip");
  git(dir, "2026-01-06", "switch", "-q", "master");
  return dir;
}

const noLog = () => {};

test("only code lines on the default branch count: rename, binary, lockfile, prose, merge, unmerged branch", async () => {
  const dir = history();
  expect(await defaultBranch(dir)).toBe("master");
  expect(await commitsIn(dir, "master")).toEqual([
    [at("2026-01-04"), 6],
    [at("2026-01-03"), 7],
    [at("2026-01-02"), 2],
    [at("2026-01-01"), 6],
  ]);
});

test("the default branch is origin/HEAD's, else main, else master", async () => {
  const main = tempDir();
  git(main, "2026-01-01", "init", "-q", "-b", "main");
  write(main, "a.ts", lines(1));
  commit(main, "2026-01-01", "c1");
  expect(await defaultBranch(main)).toBe("main");
  git(main, "2026-01-02", "branch", "trunk");
  git(main, "2026-01-02", "update-ref", "refs/remotes/origin/trunk", "trunk");
  git(main, "2026-01-02", "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk");
  expect(await defaultBranch(main)).toBe("trunk");
  const none = tempDir();
  git(none, "2026-01-01", "init", "-q", "-b", "elsewhere");
  expect(await defaultBranch(none)).toBeNull();
});

test("a new commit is read on its own and equals a full read", async () => {
  const dir = history();
  const file = join(tempDir(), "git.json");
  const cached = new GitLines(file);
  await cached.refresh(new Map([["r", dir]]), noLog);
  expect(cached.lines("r")?.length).toBe(4);
  write(dir, "e.ts", lines(3, "e"));
  commit(dir, "2026-01-07", "c5");
  await cached.refresh(new Map([["r", dir]]), noLog);
  const fresh = new GitLines(join(tempDir(), "git.json"));
  await fresh.refresh(new Map([["r", dir]]), noLog);
  expect(cached.lines("r")).toEqual(fresh.lines("r") ?? []);
  expect(cached.lines("r")?.at(-1)).toEqual([at("2026-01-07"), 3]);
  // The file on disk is what a restart starts from.
  const restarted = new GitLines(file);
  await restarted.load();
  expect(restarted.lines("r")).toEqual(cached.lines("r") ?? []);
});

test("a branch rewritten under the cache is read again from the start", async () => {
  const dir = history();
  const cached = new GitLines(join(tempDir(), "git.json"));
  await cached.refresh(new Map([["r", dir]]), noLog);
  git(dir, "2026-01-08", "reset", "-q", "--hard", "HEAD~2");
  write(dir, "f.ts", lines(5, "f"));
  commit(dir, "2026-01-08", "c6");
  await cached.refresh(new Map([["r", dir]]), noLog);
  const fresh = new GitLines(join(tempDir(), "git.json"));
  await fresh.refresh(new Map([["r", dir]]), noLog);
  expect(cached.lines("r")).toEqual(fresh.lines("r") ?? []);
  expect(cached.lines("r")).toEqual([
    [at("2026-01-01"), 6],
    [at("2026-01-02"), 2],
    [at("2026-01-08"), 5],
  ]);
});

test("a repository without a checkout has no lines", async () => {
  const dir = history();
  const cached = new GitLines(join(tempDir(), "git.json"));
  await cached.refresh(new Map([["r", dir]]), noLog);
  expect(cached.lines("cloud-only")).toBeNull();
  // Its checkout gone (or with no default branch): nothing to count.
  await cached.refresh(new Map([["r", join(dir, "nowhere")]]), noLog);
  expect(cached.lines("r")).toBeNull();
});

test("parseLog reads renames, binary files and empty commits", () => {
  const text = [
    "\x011000\0\n1\t0\tsrc/a.ts\0-\t-\timg.png\0",
    "\x012000\0",
    "\x013000\0\n4\t2\t\0old.ts\0new.ts\0",
    "\x014000\0\n9\t9\tdata.json\0",
  ].join("");
  expect(parseLog(text)).toEqual([
    [1_000_000, 1],
    [3_000_000, 4],
  ]);
});

test("code files are judged by extension and whole folder name, not by a piece of the path", () => {
  for (const path of [
    "src/a.ts",
    "notes.mdx",
    "src/vendors/y.ts",
    "dist.ts",
    "Dockerfile",
    "panel/style.css",
    "a/migrations.ts",
    "fixtures.py",
  ]) {
    expect(isCode(path)).toBe(true);
  }
  for (const path of [
    "bun.lock",
    "apps/x/package-lock.json",
    "pnpm-lock.yaml",
    "Cargo.lock",
    "a.md",
    "b.JSON",
    "log/x.jsonl",
    "ci.yml",
    "ci.yaml",
    "t.txt",
    "d.csv",
    "i.svg",
    "x.lock",
    "run.log",
    "app.min.js",
    "vendor/x.ts",
    "a/node_modules/b/c.js",
    "web/dist/app.js",
    "app/migrations/0001.py",
    "test/fixtures/a.ts",
  ]) {
    expect(isCode(path)).toBe(false);
  }
});
