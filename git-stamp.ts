/**
 * A cheap answer to "could git's answers for this checkout have changed since
 * I last asked": the mtime, size and inode of each file git reads to find the
 * default branch and its tip. Reading them is a few dozen `stat`s in the
 * host's own process; asking git for the same is two processes per repository
 * (measured 2026-09-30: 18 repositories, ~36 spawns a minute, each ~2 ms of
 * the host's main thread, the whole read p50 343 ms, p95 851 ms).
 */

import { readFileSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";

/** A file changed this recently may change again within the same mtime tick: not to be trusted. */
const RACY_MS = 1000;

function fileOrNull(path: string): string | null {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return null;
  }
}

/** Where `.git` points: a linked worktree's is a file `gitdir: <dir>`, and its `commondir` names the shared one. */
function gitDirs(checkout: string): { own: string; common: string } {
  const dot = join(checkout, ".git");
  const text = statSync(dot, { throwIfNoEntry: false })?.isFile() ? fileOrNull(dot) : null;
  const pointed = text?.startsWith("gitdir:") ? text.slice("gitdir:".length).trim() : null;
  if (pointed === null) return { own: dot, common: dot };
  const own = isAbsolute(pointed) ? pointed : join(checkout, pointed);
  const common = fileOrNull(join(own, "commondir"));
  return { own, common: common === null ? own : isAbsolute(common) ? common : join(own, common) };
}

/** `branch` without a leading `origin/`: the name the refs are stored under. */
function shortName(branch: string | null): string[] {
  return branch === null ? [] : [branch.replace(/^origin\//, "")];
}

/**
 * The fingerprint of `checkout`, or null where a file changed within the last
 * second: it is to be taken before git is run, and a null one is never equal
 * to anything. A missing file is a value of its own.
 */
export function stampOf(checkout: string, branch: string | null, now = Date.now()): string | null {
  const { own, common } = gitDirs(checkout);
  const names = [...new Set([...shortName(branch), "main", "master"])].sort();
  const files = [
    join(own, "HEAD"),
    join(common, "packed-refs"),
    join(common, "FETCH_HEAD"),
    join(common, "refs", "remotes", "origin", "HEAD"),
    ...names.flatMap((name) => [
      join(common, "refs", "remotes", "origin", name),
      join(common, "refs", "heads", name),
    ]),
  ];
  const parts = [own, common];
  for (const file of files) {
    const stat = statSync(file, { throwIfNoEntry: false });
    if (stat !== undefined && now - stat.mtimeMs < RACY_MS) return null;
    parts.push(stat === undefined ? "-" : `${stat.mtimeMs}:${stat.size}:${stat.ino}`);
  }
  return parts.join("|");
}
