/**
 * Which repository and which folder a call was made in.
 *
 * The folder is the session's working directory, with the home folder as `~`.
 * The repository is the checkout's main repository: a worktree of prifly
 * (`~/src/prifly.worktrees/token-stats`) counts as prifly, found from its
 * `.git` file where it still exists and from the `.worktrees/` naming where
 * it has been removed since.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

const HOME = homedir();

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

/** From the path alone, for a folder that is gone: `x.worktrees/y` is x, a scratchpad is a scratchpad. */
function guessRepo(cwd: string): string {
  if (/\/scratchpad(\/|$)/.test(cwd) || cwd.startsWith("/tmp/")) return "scratchpads";
  const worktree = /^(.*?)\.worktrees\//.exec(cwd)?.[1];
  if (worktree !== undefined) return basename(worktree);
  const nested = /^(.*?)\/(\.claude\/worktrees|worktrees)\//.exec(cwd)?.[1];
  if (nested !== undefined) return basename(nested);
  return cwd === HOME ? "~" : basename(cwd) || "unknown";
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
    return top === null ? guessRepo(cwd) : nameOf(top);
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
