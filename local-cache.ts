/**
 * The scan's cache across host restarts, in SQLite: one row per transcript
 * for where its reading stopped, and its calls as chunks appended per scan.
 *
 * It replaced `cache/local.json`, which was written whole after every scan
 * that read anything: on 2026-09-27 that was 44.8 MB a minute with sessions
 * running, about 60 GB a day and 85 % of the host's disk writes, to record a
 * few files having grown. Here a scan writes only what changed since the
 * last one — each grown file's position and its new calls — so its cost
 * follows what was read, not how much history there is. A single transcript
 * reaches 1.3 MB of calls, which is why they are appended, not rewritten.
 *
 * Every save is one transaction in SQLite's default rollback journal: a host
 * killed mid-save leaves the previous scan's state, and deleting the
 * database while the host is stopped leaves no write-ahead log behind.
 */

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { FileOut } from "./archive";
import type { ReaderState, Usage } from "./parse";

export type FileState = FileOut & {
  size: number;
  mtime: number;
  offset: number;
  reader: ReaderState;
};

/** A file's row without its calls. */
type Position = Omit<FileState, "usages">;

/** What the database holds for one file, to tell what a scan changed. */
type Saved = { state: FileState; calls: number; size: number; mtime: number; title: string };

/** An upsert keeps the row's rowid, so files load in the order they were first seen, as before. */
const UPSERT_FILE = `INSERT INTO files (path, position) VALUES (?, ?)
  ON CONFLICT (path) DO UPDATE SET position = excluded.position`;

/** A file whose calls have piled up in more chunks than this is rewritten as one on load. */
const MAX_CHUNKS = 32;

export class LocalCache {
  private readonly db: Database;
  private readonly saved = new Map<string, Saved>();
  private readonly version: number;

  /** `version` changes when what a call records does: an older cache is dropped and read again. */
  constructor(file: string, version: number) {
    this.version = version;
    mkdirSync(dirname(file), { recursive: true });
    this.db = new Database(file, { create: true, strict: true });
    this.db.run(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    this.db.run(`CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, position TEXT NOT NULL)`);
    this.db.run(
      `CREATE TABLE IF NOT EXISTS chunks (id INTEGER PRIMARY KEY, path TEXT NOT NULL, calls TEXT NOT NULL)`,
    );
    this.db.run(`CREATE INDEX IF NOT EXISTS chunks_path ON chunks (path)`);
  }

  close(): void {
    this.db.close();
  }

  /**
   * Every file the cache knows. The first time, with nothing stored yet, it
   * starts from `legacyFile` — the old whole-file cache — which is read but
   * left where it is.
   */
  load(legacyFile: string): FileState[] {
    this.db.transaction(() => this.settleVersion(legacyFile))();
    const states = new Map<string, FileState>();
    for (const row of this.db.query<{ path: string; position: string }, []>(
      `SELECT path, position FROM files ORDER BY rowid`,
    )) {
      states.set(row.path, { ...(JSON.parse(row.position) as Position), usages: [] });
    }
    const chunks = new Map<string, number>();
    for (const row of this.db.query<{ path: string; calls: string }, []>(
      `SELECT path, calls FROM chunks ORDER BY id`,
    )) {
      const state = states.get(row.path);
      if (state === undefined) continue;
      state.usages.push(...(JSON.parse(row.calls) as Usage[]));
      chunks.set(row.path, (chunks.get(row.path) ?? 0) + 1);
    }
    for (const state of states.values()) this.remember(state);
    const piled = [...chunks].filter(([, count]) => count > MAX_CHUNKS).map(([path]) => path);
    this.db.transaction(() => {
      for (const path of piled) {
        const state = states.get(path);
        if (state !== undefined) this.writeCalls(state, state.usages, true);
      }
    })();
    return [...states.values()];
  }

  /**
   * Write what changed in `files` since the last save or load: files read
   * further, files read again from the start, files gone. Returns the rows
   * written, so a scan that changed nothing is seen to write nothing.
   */
  save(files: ReadonlyMap<string, FileState>): number {
    let rows = 0;
    this.db.transaction(() => {
      for (const path of this.saved.keys()) {
        if (files.has(path)) continue;
        this.db.run(`DELETE FROM files WHERE path = ?`, [path]);
        this.db.run(`DELETE FROM chunks WHERE path = ?`, [path]);
        this.saved.delete(path);
        rows += 1;
      }
      for (const state of files.values()) rows += this.saveFile(state);
    })();
    return rows;
  }

  private saveFile(state: FileState): number {
    const saved = this.saved.get(state.path);
    // The scan replaces a file's state when it was cut shorter: its old calls go.
    const restarted = saved !== undefined && saved.state !== state;
    const from = saved === undefined || restarted ? 0 : saved.calls;
    const moved =
      saved === undefined ||
      restarted ||
      saved.size !== state.size ||
      saved.mtime !== state.mtime ||
      saved.title !== state.title;
    if (!moved && from === state.usages.length) return 0;
    const { usages: _, ...position } = state;
    this.db.run(UPSERT_FILE, [state.path, JSON.stringify(position)]);
    const fresh = state.usages.slice(from);
    if (restarted || fresh.length > 0) this.writeCalls(state, fresh, restarted);
    this.remember(state);
    return 1 + (fresh.length > 0 ? 1 : 0);
  }

  private writeCalls(state: FileState, calls: readonly Usage[], replace: boolean): void {
    if (replace) this.db.run(`DELETE FROM chunks WHERE path = ?`, [state.path]);
    if (calls.length === 0) return;
    this.db.run(`INSERT INTO chunks (path, calls) VALUES (?, ?)`, [
      state.path,
      JSON.stringify(calls),
    ]);
  }

  private remember(state: FileState): void {
    const { size, mtime, title } = state;
    this.saved.set(state.path, { state, calls: state.usages.length, size, mtime, title });
  }

  /** Drops a cache of another version; imports the old JSON cache into an empty one, once. */
  private settleVersion(legacyFile: string): void {
    const stored = this.db
      .query<{ value: string }, [string]>(`SELECT value FROM meta WHERE key = ?`)
      .get("version");
    if (stored?.value === String(this.version)) return;
    this.db.run(`DELETE FROM files`);
    this.db.run(`DELETE FROM chunks`);
    this.db.run(`INSERT OR REPLACE INTO meta (key, value) VALUES ('version', ?)`, [
      String(this.version),
    ]);
    // Only a brand-new database takes the old cache: a version change means its calls are stale.
    if (stored === null) this.importLegacy(legacyFile);
  }

  private importLegacy(legacyFile: string): void {
    if (!existsSync(legacyFile)) return;
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(legacyFile, "utf8"));
    } catch (caught) {
      // Half-written or not JSON: the scan reads the transcripts instead.
      if (caught instanceof SyntaxError) return;
      throw caught;
    }
    const cache = raw as { version?: unknown; files?: unknown } | null;
    if (cache?.version !== this.version || !Array.isArray(cache.files)) return;
    for (const state of cache.files as FileState[]) {
      const { usages, ...position } = state;
      this.db.run(UPSERT_FILE, [state.path, JSON.stringify(position)]);
      this.writeCalls(state, usages, true);
    }
  }
}
