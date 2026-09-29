/**
 * Lines of code added, read from a repository's git history.
 *
 * Only the default branch counts (`origin/HEAD`, else `main`, else `master`),
 * merges are left out and a commit is dated by its committer time, the day it
 * landed. Each commit is the lines it added in code files (`code-filter.ts`);
 * binary files and commits that added no code are not kept. Git is run with
 * an argument list, never through a shell.
 */

import { isCode } from "./code-filter";

/** When a commit was made (ms) and the lines of code it added. */
export type Commit = readonly [ts: number, lines: number];

/** A git command that failed where it should not have: the repository is unreadable this time. */
export class GitFailed extends Error {}

type Ran = { ok: boolean; out: string };

async function git(path: string, args: readonly string[]): Promise<Ran> {
  const proc = Bun.spawn(["git", "-C", path, ...args], {
    stdout: "pipe",
    stderr: "ignore",
    stdin: "ignore",
  });
  const [out] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return { ok: proc.exitCode === 0, out };
}

async function refExists(path: string, ref: string): Promise<boolean> {
  return (await git(path, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])).ok;
}

/** `origin/HEAD`'s branch, else `main`, else `master`: a local branch, or failing that origin's. */
export async function defaultBranch(path: string): Promise<string | null> {
  const origin = await git(path, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  const named = origin.ok ? origin.out.trim().replace(/^origin\//, "") : "";
  const candidates = [...new Set([named, "main", "master"])].filter((name) => name !== "");
  for (const name of candidates) {
    if (await refExists(path, `refs/heads/${name}`)) return name;
    if (await refExists(path, `refs/remotes/origin/${name}`)) return `origin/${name}`;
  }
  return null;
}

/** The commit a branch is at, or null where it has none. */
export async function tipOf(path: string, branch: string): Promise<string | null> {
  const ran = await git(path, ["rev-parse", "--verify", "--quiet", `${branch}^{commit}`]);
  return ran.ok ? ran.out.trim() : null;
}

/** Whether `older` is in `newer`'s history: false too where git does not know `older` any more. */
export async function isAncestor(path: string, older: string, newer: string): Promise<boolean> {
  return (await git(path, ["merge-base", "--is-ancestor", older, newer])).ok;
}

const STAT = /^(\d+|-)\t(\d+|-)\t(.*)$/;

/**
 * `git log -z --numstat --format=%x01%ct`: per commit `\x01<time>\0`, then
 * `added\tdeleted\tpath\0` for each file; a rename is `added\tdeleted\t\0old\0new\0`,
 * a binary file `-\t-\tpath`. The first file of a commit follows a newline.
 */
export function parseLog(text: string): Commit[] {
  const commits: Commit[] = [];
  for (const chunk of text.split("\x01")) {
    const [stamp = "", ...tokens] = chunk.split("\0");
    const ts = Number(stamp) * 1000;
    const lines = linesOf(tokens);
    if (stamp !== "" && Number.isFinite(ts) && lines > 0) commits.push([ts, lines]);
  }
  return commits;
}

/** The code lines a commit's file tokens add. */
function linesOf(tokens: readonly string[]): number {
  let lines = 0;
  for (let k = 0; k < tokens.length; k++) {
    const stat = STAT.exec((tokens[k] ?? "").replace(/^\n/, ""));
    if (stat === null) continue;
    const [, added = "-", , path = ""] = stat;
    // A rename leaves the path empty and names the two paths in the next tokens.
    const name = path === "" ? tokens[k + 2] : path;
    if (path === "") k += 2;
    if (added !== "-" && name !== undefined && isCode(name)) lines += Number(added);
  }
  return lines;
}

/** Every non-merge commit `range` names (a branch, or `old..branch`), with its code lines. */
export async function commitsIn(path: string, range: string): Promise<Commit[]> {
  const ran = await git(path, [
    "log",
    range,
    "--no-merges",
    "-M",
    "--numstat",
    "-z",
    "--format=%x01%ct",
  ]);
  if (!ran.ok) throw new GitFailed(`git log ${range} failed in ${path}`);
  return parseLog(ran.out);
}
