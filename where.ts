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

/** `/home/jimmy/src/odi` as `~/src/odi`. */
export function folderLabel(cwd: string): string {
  if (cwd === "") return "unknown";
  if (cwd === HOME) return "~";
  return cwd.startsWith(`${HOME}/`) ? `~${cwd.slice(HOME.length)}` : cwd;
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
  try {
    const config = readFileSync(join(top, ".git", "config"), "utf8");
    const origin = /\[remote "origin"\][^[]*?url\s*=\s*(\S+)/.exec(config)?.[1];
    if (origin !== undefined) return repoOfUrl(origin);
  } catch {
    // No config to read: the folder's name is the best there is.
  }
  return basename(top);
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
