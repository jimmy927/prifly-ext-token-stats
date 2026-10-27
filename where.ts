/**
 * Which repository and which folder a call was made in.
 *
 * The folder is the session's working directory, with the home folder as `~`.
 * The repository is the checkout's main repository: a worktree of prifly
 * (`~/src/prifly.worktrees/token-stats`) counts as prifly, found from its
 * `.git` file where it still exists and from the `.worktrees/` naming where
 * it has been removed since.
 *
 * A folder in no repository at all (`~/src`, the home folder, a scratchpad)
 * is `NO_REPO`, never the folder's name: `store.ts` then places its calls by
 * the files the session wrote (`repoOfPath`).
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

const HOME = homedir();

/** The repository of a folder that is in none. */
export const NO_REPO = "(no repository)";

/**
 * `/home/jimmy/src/odi` as `~/src/odi`. `home` is the home folder of the
 * machine the call ran on: this one's, or another machine's whose history
 * prifly copied here (`homeOf`).
 */
export function folderLabel(cwd: string, home: string = HOME): string {
  if (cwd === "") return "unknown";
  if (cwd === home) return "~";
  // Either separator: a host on Windows has `C:\Users\jimmy\src`.
  const next = cwd[home.length];
  return cwd.startsWith(home) && (next === "/" || next === "\\")
    ? `~${cwd.slice(home.length)}`
    : cwd;
}

/**
 * The home folder most of a machine's calls ran under, `/home/<user>` or
 * `/root`; null where none did. For the copy of another machine's history,
 * whose home this host cannot ask: a WSL distribution's, for a host on Windows.
 */
export function homeOf(cwds: Iterable<string>): string | null {
  const counts = new Map<string, number>();
  for (const cwd of cwds) {
    const home = /^(\/home\/[^/]+|\/root)(\/|$)/.exec(cwd)?.[1];
    if (home !== undefined) counts.set(home, (counts.get(home) ?? 0) + 1);
  }
  let best: string | null = null;
  for (const [home, n] of counts) if (best === null || n > (counts.get(best) ?? 0)) best = home;
  return best;
}

/** The main checkout a `.git` file points back to, or null for a plain repository. */
function mainOfWorktree(gitFile: string): string | null {
  const text = readFileSync(gitFile, "utf8");
  const gitdir = /^gitdir:\s*(.+)$/m.exec(text)?.[1]?.trim();
  if (gitdir === undefined) return null;
  // <main>/.git/worktrees/<name>
  const at = gitdir.indexOf("/.git/worktrees/");
  return at < 0 ? null : gitdir.slice(0, at);
}

/** The repository's top folder, walking up from `cwd`; null outside any. */
function gitTop(cwd: string): string | null {
  for (let dir = cwd; dir !== dirname(dir); dir = dirname(dir)) {
    const git = join(dir, ".git");
    if (!existsSync(git)) continue;
    return statSync(git).isFile() ? (mainOfWorktree(git) ?? dir) : dir;
  }
  return null;
}

/** The main checkout a worktree's path names: `x.worktrees/y` and `x/.claude/worktrees/y` are x. */
function worktreeMain(path: string): string | null {
  return (
    /^(.*?)\.worktrees\//.exec(path)?.[1] ??
    /^(.*?)\/(\.claude\/worktrees|worktrees)\//.exec(path)?.[1] ??
    null
  );
}

/** From the path alone, for a folder that is gone: `x.worktrees/y` is x, a scratchpad is in none. */
function guessRepo(cwd: string): string {
  if (/\/scratchpad(\/|$)/.test(cwd) || cwd.startsWith("/tmp/")) return NO_REPO;
  const main = worktreeMain(cwd);
  if (main !== null) return basename(main);
  return cwd === HOME ? NO_REPO : basename(cwd) || "unknown";
}

/**
 * A checkout by its origin's name, so `~/src/odi3` and `~/src/odi5` — clones
 * of one repository — are the one repository they are; its folder's name
 * where it has no origin.
 */
function nameOf(top: string): string {
  if (top === HOME) return "~";
  const name = originName(top);
  noteCheckout(name, top);
  return name;
}

function originName(top: string): string {
  try {
    const config = readFileSync(join(top, ".git", "config"), "utf8");
    const origin = /\[remote "origin"\][^[]*?url\s*=\s*(\S+)/.exec(config)?.[1];
    if (origin !== undefined) return repoOfUrl(origin);
  } catch {
    // No config to read: the folder's name is the best there is.
  }
  return basename(top);
}

/** The main checkouts seen for each repository name, in this thread. */
const CHECKOUTS = new Map<string, Set<string>>();

function noteCheckout(name: string, top: string): void {
  const known = CHECKOUTS.get(name);
  if (known === undefined) CHECKOUTS.set(name, new Set([top]));
  else known.add(top);
}

/**
 * The main checkout of a repository by name, for reading its git history;
 * null where this machine has none. Of several clones of one repository
 * (`~/src/odi`, `odi3`, `odi5`) the one whose folder is the bare name; else
 * the first by path. A repository never seen as a folder here (a session
 * outside it only wrote into it, or a cloud session ran in it) is looked for
 * at `~/src/<name>`, when that has this name as its origin.
 */
export function checkoutOf(name: string): string | null {
  const found = new Set(CHECKOUTS.get(name));
  const conventional = join(HOME, "src", name);
  if (existsSync(join(conventional, ".git")) && originName(conventional) === name) {
    found.add(conventional);
  }
  const rank = (path: string) => Number(basename(path) !== name);
  const best = [...found]
    .filter((path) => existsSync(join(path, ".git")))
    .sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : 1));
  return best[0] ?? null;
}

/** A folder that still exists, by its git origin; null for one that is gone or unreadable. */
function liveRepo(cwd: string): string | null {
  try {
    if (!existsSync(cwd)) return null;
    const top = gitTop(cwd);
    if (top !== null) return nameOf(top);
    // What is left of a removed worktree (`x.worktrees/y` without its `.git`) is still x's.
    return repoOfPath(cwd) ?? NO_REPO;
  } catch {
    // Unreadable on the way up (permissions, a racing delete): as good as gone.
    return null;
  }
}

/**
 * The repository of each folder, by name. Folders that still exist are asked
 * git first; a deleted clone is then known by its name, with a trailing number
 * dropped when that names a repository found live — `~/odi3`, long gone, was a
 * clone of `odi` as surely as `~/odi5`, which is still there, is.
 */
export function resolveRepos(cwds: Iterable<string>): Map<string, string> {
  const out = new Map<string, string>();
  const gone: string[] = [];
  for (const cwd of new Set(cwds)) {
    const live = cwd === "" ? "unknown" : liveRepo(cwd);
    if (live === null) gone.push(cwd);
    else out.set(cwd, live);
  }
  const known = new Set(out.values());
  for (const cwd of gone) {
    const guess = guessRepo(cwd);
    const stripped = guess.replace(/[-_]?\d+$/, "");
    out.set(cwd, stripped !== guess && known.has(stripped) ? stripped : guess);
  }
  return out;
}

/**
 * The repository a written file is in; null for one in none, such as a
 * scratch file. A file that is gone since is placed by the nearest folder
 * above it that is still there, when that is in a checkout (a deleted file
 * of `~/src/odi`, or of a removed `~/src/odi/.claude/worktrees/x`, is odi),
 * and otherwise by its path's naming: in a removed `~/src/odi.worktrees/x`
 * it is odi, by `~/src/odi`'s origin while that is there.
 */
export function repoOfPath(path: string): string | null {
  try {
    let there = path;
    while (there !== dirname(there) && !existsSync(there)) there = dirname(there);
    const top = gitTop(there);
    if (top !== null) return nameOf(top);
    const main = worktreeMain(path);
    if (main === null) return null;
    const mainTop = existsSync(main) ? gitTop(main) : null;
    return mainTop === null ? basename(main) : nameOf(mainTop);
  } catch {
    // Unreadable on the way up (permissions, a racing delete): nothing to go by.
    return null;
  }
}

/** A repository URL, `https://github.com/o/r(.git)` or `git@github.com:o/r.git`, as `r`. */
export function repoOfUrl(url: string): string {
  const name = basename(
    url
      .replace(/\/+$/, "")
      .replace(/\.git$/, "")
      .replace(/^.*:/, "/"),
  );
  return name === "" ? "unknown" : name;
}
