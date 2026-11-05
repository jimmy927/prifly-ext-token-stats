/**
 * Which transcripts a scan looks at.
 *
 * Listing and stat'ing every transcript under `~/.claude/projects` each
 * minute was most of a scan on 2026-09-28: about 3,070 files in 830 folders,
 * all but a handful unchanged, and ~16 MB a minute of disk reads on WSL2,
 * where the page cache drops ~500 MB every ~30 s and takes the folder and
 * inode metadata with it.
 *
 * A folder's mtime cannot stand in: it moves when an entry is created,
 * removed or renamed, not when a transcript is appended to, which is how
 * they grow. So the root is watched instead (inotify, through Bun's
 * recursive `fs.watch`, which also watches folders created later), and a
 * scan stats only what the watcher named since the last one. Tried on this
 * ext4 path on 2026-09-28: an append, a new session folder with its
 * `subagents/` and file created in the same breath, a rename and a delete
 * each reported, our own reads not; symlinked project folders are not
 * followed, and events come under the real folder's name.
 *
 * A full pass — list everything, stat everything — still runs on the first
 * scan, every `FULL_EVERY`, and on every scan while the watcher is down, so
 * a lost event makes a change at most that late. A full pass counts the
 * changed files the watcher had not named (`missed`), so a watcher that
 * drops events shows in the log.
 */

import { type FSWatcher, lstatSync, readdirSync, watch } from "node:fs";
import { join } from "node:path";

export const FULL_EVERY = 10 * 60_000;

export type Selection = {
  /** The sessions' own transcripts, stat'ed before sub-agents': a sub-agent's account is read off its parent's. */
  main: string[];
  agents: string[];
  /** The whole listing: a file not in it is gone. */
  full: boolean;
  /** Not a full pass: paths found gone since the last scan, files or folders with everything under them. */
  gone: string[];
  /** A full pass with the watcher up since the last scan: what it named, for `missedBy`. */
  flagged: ReadonlySet<string> | null;
  /** Folders read and paths lstat'ed choosing these. */
  dirs: number;
  statted: number;
};

type Found = { main: Set<string>; agents: Set<string>; dirs: number; statted: number };

export class Transcripts {
  private readonly root: string;
  private readonly fullEvery: number;
  private readonly now: () => number;
  private watcher: FSWatcher | null = null;
  /** Paths under the root the watcher named since the last scan. */
  private dirty = new Set<string>();
  /** The next scan must list everything: nothing watched yet, or an event without a name. */
  private blind = true;
  private fullAt = Number.NEGATIVE_INFINITY;

  constructor(root: string, fullEvery = FULL_EVERY, now: () => number = Date.now) {
    this.root = root;
    this.fullEvery = fullEvery;
    this.now = now;
  }

  close(): void {
    this.watcher?.close();
    this.watcher = null;
  }

  select(): Selection {
    const due = this.now() - this.fullAt >= this.fullEvery;
    return this.blind || this.watcher === null || due ? this.full() : this.changed();
  }

  private full(): Selection {
    const flagged = this.blind || this.watcher === null ? null : this.dirty;
    // Watching starts before the listing: whatever is written while it runs is named next time.
    this.watcher ??= this.startWatch();
    this.dirty = new Set();
    this.blind = this.watcher === null;
    this.fullAt = this.now();
    const found = emptyFound();
    for (const entry of readdirSync(this.root, { withFileTypes: true })) {
      if (entry.isDirectory() && !this.isLink(entry.name, found)) {
        this.walk(join(this.root, entry.name), found);
      }
    }
    found.dirs += 1;
    return { ...listed(found), full: true, gone: [], flagged };
  }

  /** What the watcher named: files stat'ed, new folders listed, vanished paths reported gone. */
  private changed(): Selection {
    const names = this.dirty;
    this.dirty = new Set();
    const found = emptyFound();
    const gone: string[] = [];
    for (const name of names) {
      const path = join(this.root, name);
      found.statted += 1;
      const stat = lstatOrNull(path);
      if (stat === null) gone.push(path);
      else if (this.isLink(name.split("/")[0] ?? name, found)) continue;
      else if (stat.isDirectory()) this.walk(path, found);
      else if (stat.isFile() && name.includes("/")) add(found, path);
    }
    return { ...listed(found), full: false, gone, flagged: null };
  }

  /** `~/odi` beside `~/src/odi`: a symlinked project folder repeats another. */
  private isLink(top: string, found: Found): boolean {
    found.statted += 1;
    return lstatOrNull(join(this.root, top))?.isSymbolicLink() ?? false;
  }

  private walk(dir: string, found: Found): void {
    found.dirs += 1;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) this.walk(path, found);
      else if (entry.isFile()) add(found, path);
    }
  }

  private startWatch(): FSWatcher | null {
    let watcher: FSWatcher;
    try {
      watcher = watch(this.root, { recursive: true }, (_event, name) => {
        if (typeof name === "string") this.dirty.add(name);
        else this.blind = true;
      });
    } catch (caught) {
      // Out of inotify watches (ENOSPC) or the like: every scan is a full pass, as before.
      if (caught instanceof Error && "code" in caught) return null;
      throw caught;
    }
    watcher.on("error", () => {
      watcher.close();
      if (this.watcher === watcher) this.watcher = null;
      this.blind = true;
    });
    return watcher;
  }
}

/** Changed files a full pass read that the watcher had not named since the last scan. */
export function missedBy(root: string, flagged: ReadonlySet<string>, changed: string[]): number {
  return changed.filter((path) => {
    // A new folder is named once, for everything created in it.
    for (let at = path.length; at > root.length; at = lastSep(path, at - 1)) {
      if (flagged.has(path.slice(root.length + 1, at))) return false;
    }
    return true;
  }).length;
}

/** The last `/`, or `\` on Windows, at or before `at`. */
function lastSep(path: string, at: number): number {
  return Math.max(path.lastIndexOf("/", at), path.lastIndexOf("\\", at));
}

function emptyFound(): Found {
  return { main: new Set(), agents: new Set(), dirs: 0, statted: 0 };
}

function add(found: Found, path: string): void {
  if (!path.endsWith(".jsonl")) return;
  // Either separator: on Windows the paths have `\`.
  (/[\\/]subagents[\\/]/.test(path) ? found.agents : found.main).add(path);
}

function listed(found: Found) {
  const { dirs, statted } = found;
  return { main: [...found.main], agents: [...found.agents], dirs, statted };
}

function lstatOrNull(path: string) {
  try {
    return lstatSync(path);
  } catch (caught) {
    const code = caught instanceof Error && "code" in caught ? caught.code : null;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw caught;
  }
}
