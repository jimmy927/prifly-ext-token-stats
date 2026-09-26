/**
 * History beyond Claude Code's own cleanup. Claude Code deletes transcripts
 * older than `cleanupPeriodDays` (30 by default); what was read from one
 * before it went is kept here, forever, so the statistics outlive the files.
 *
 * The archive is its own file (`cache/archive.json`), apart from the live
 * scan cache: that one may be deleted or reset at any time and is rebuilt
 * from the transcripts on disk, but nothing could rebuild the archive. It
 * only grows, so a call is stored as numbers: its strings go in one table.
 */

import { existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import type { Usage } from "./parse";

export type FileOut = {
  path: string;
  sessionId: string;
  /** The session a sub-agent's transcript belongs to; null for a session's own. */
  parentId: string | null;
  title: string;
  usages: Usage[];
};

const ARCHIVE_VERSION = 1;

/**
 * ts, account, model, cwd (the last three as indexes into `strings`), then the
 * four counts, and last the 1-hour cache writes. Calls archived before that
 * was kept have eight entries, not nine, and still read under version 1:
 * their cache writes are priced at the 5-minute rate (see `costOf`).
 */
type PackedUsage =
  | [number, number, number, number, number, number, number, number]
  | [number, number, number, number, number, number, number, number, number];
type PackedFile = [string, string, string | null, string, PackedUsage[]];
type ArchiveJson = { version: number; strings: string[]; files: PackedFile[] };

export function encodeArchive(files: Iterable<FileOut>): ArchiveJson {
  const strings: string[] = [];
  const index = new Map<string, number>();
  const code = (s: string) => {
    let at = index.get(s);
    if (at === undefined) {
      at = strings.push(s) - 1;
      index.set(s, at);
    }
    return at;
  };
  const packed = [...files].map(
    (file): PackedFile => [
      file.path,
      file.sessionId,
      file.parentId,
      file.title,
      file.usages.map((u): PackedUsage => {
        const counts = [
          u.ts,
          code(u.account),
          code(u.model),
          code(u.cwd),
          u.input,
          u.cacheWrite,
          u.cacheRead,
          u.output,
        ] as const;
        return u.cacheWrite1h === undefined ? [...counts] : [...counts, u.cacheWrite1h];
      }),
    ],
  );
  return { version: ARCHIVE_VERSION, strings, files: packed };
}

/** The archived files, or null when `raw` is not an archive this version wrote. */
export function decodeArchive(raw: unknown): FileOut[] | null {
  const archive = raw as Partial<ArchiveJson> | null;
  if (typeof archive !== "object" || archive === null) return null;
  if (archive.version !== ARCHIVE_VERSION) return null;
  const { strings, files } = archive;
  if (!Array.isArray(strings) || !Array.isArray(files)) return null;
  try {
    return unpack(strings, files);
  } catch (caught) {
    // An entry of the wrong shape: not destructurable, or its usages not a list.
    if (caught instanceof TypeError) return null;
    throw caught;
  }
}

function unpack(strings: string[], files: PackedFile[]): FileOut[] {
  const str = (at: number) => strings[at] ?? "";
  return files.map(([path, sessionId, parentId, title, usages]) => ({
    path,
    sessionId,
    parentId,
    title,
    usages: usages.map(
      ([ts, account, model, cwd, input, cacheWrite, cacheRead, output, cacheWrite1h]) => ({
        ts,
        account: str(account),
        model: str(model),
        cwd: str(cwd),
        input,
        cacheWrite,
        ...(cacheWrite1h === undefined ? {} : { cacheWrite1h }),
        cacheRead,
        output,
      }),
    ),
  }));
}

/**
 * The archive on disk. One that cannot be read is moved aside rather than
 * left to be overwritten by the next archiving: history lost is lost for good.
 */
export async function loadArchive(file: string): Promise<FileOut[]> {
  if (!existsSync(file)) return [];
  const raw: unknown = await Bun.file(file)
    .json()
    .catch(() => null);
  const files = decodeArchive(raw);
  if (files !== null) return files;
  renameSync(file, `${file}.unreadable-${Date.now()}`);
  return [];
}

/** Written whole to a temporary file first, so a crash mid-write leaves the old archive. */
export async function saveArchive(file: string, files: Iterable<FileOut>): Promise<void> {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.writing`;
  await Bun.write(temporary, JSON.stringify(encodeArchive(files)));
  renameSync(temporary, file);
}

/**
 * One scan's change to the archive: files that left the disk go in, and a
 * path that is on disk again leaves it — the live file is counted instead,
 * never both.
 */
export function settleArchive(
  archive: Map<string, FileOut>,
  gone: readonly FileOut[],
  present: ReadonlySet<string>,
): { archived: FileOut[]; reclaimed: string[] } {
  const reclaimed = [...archive.keys()].filter((path) => present.has(path));
  for (const path of reclaimed) archive.delete(path);
  for (const file of gone) archive.set(file.path, file);
  return { archived: [...gone], reclaimed };
}

/** What a scan reply changes in the main thread's two maps; true when anything did. */
export type ScanChanges = {
  files: readonly FileOut[];
  removed: readonly string[];
  archived: readonly FileOut[];
  reclaimed: readonly string[];
};

export function applyScan(
  live: Map<string, FileOut>,
  archive: Map<string, FileOut>,
  changes: ScanChanges,
): boolean {
  for (const path of changes.removed) live.delete(path);
  for (const path of changes.reclaimed) archive.delete(path);
  for (const file of changes.files) {
    live.set(file.path, file);
    archive.delete(file.path);
  }
  for (const file of changes.archived) archive.set(file.path, file);
  const { files, removed, archived, reclaimed } = changes;
  return [files, removed, archived, reclaimed].some((list) => list.length > 0);
}
