/**
 * What counts as code when lines are added: everything but lockfiles, data
 * and prose formats, generated or copied-in folders. A file is judged by its
 * whole name, its extension and the whole folder names above it, never by a
 * piece of the path: `.json` must not swallow `.jsonl`, nor `vendor` a
 * folder called `vendors`.
 *
 * Change the lists and raise `FILTER_VERSION`: `git-cache.ts` then reads every
 * repository's history again instead of trusting counts made under the old
 * lists.
 */

import { basename, dirname, extname } from "node:path";

export const FILTER_VERSION = 1;

const LOCKFILES = new Set([
  "bun.lock",
  "package-lock.json",
  "uv.lock",
  "yarn.lock",
  "pnpm-lock.yaml",
  "Cargo.lock",
  "poetry.lock",
]);

/** Lower case, with the dot. */
const EXTENSIONS = new Set([
  ".md",
  ".json",
  ".jsonl",
  ".yml",
  ".yaml",
  ".txt",
  ".csv",
  ".svg",
  ".lock",
  ".log",
]);

/** Whole folder names, at any depth. */
const FOLDERS = new Set(["migrations", "vendor", "node_modules", "dist", "fixtures"]);

/** Whether a file, by its path in the repository (`/`-separated), is code. */
export function isCode(path: string): boolean {
  const name = basename(path);
  if (LOCKFILES.has(name)) return false;
  const lower = name.toLowerCase();
  if (lower.endsWith(".min.js") || EXTENSIONS.has(extname(lower))) return false;
  return !dirname(path)
    .split("/")
    .some((segment) => FOLDERS.has(segment));
}
