/**
 * Every call, local and remote, as columns: a timestamp, a code per
 * dimension, and the four token counts. Rebuilt from the per-file results
 * whenever one of them changes — a few hundred thousand rows take
 * milliseconds — and queried by `query.ts`.
 */

import type { Usage } from "./parse";
import { folderLabel, repoOf } from "./where";

export const DIMENSIONS = ["account", "model", "repo", "folder", "source", "session"] as const;
export type Dimension = (typeof DIMENSIONS)[number];

/** One transcript's calls, with what they share: whose session, local or remote. */
export type Batch = {
  sessionId: string;
  title: string;
  source: "local" | "remote";
  /** A remote session's repository; local ones are found from each call's folder. */
  repo: string | null;
  usages: readonly Usage[];
};

export type Columns = {
  length: number;
  ts: Float64Array;
  codes: Record<Dimension, Int32Array>;
  /** The strings each dimension's codes stand for. */
  names: Record<Dimension, string[]>;
  input: Float64Array;
  cacheWrite: Float64Array;
  cacheRead: Float64Array;
  output: Float64Array;
  /** A session's words, by session id: its title. */
  titles: Map<string, string>;
};

class Interner {
  readonly names: string[] = [];
  private readonly codes = new Map<string, number>();
  code(name: string): number {
    const known = this.codes.get(name);
    if (known !== undefined) return known;
    this.names.push(name);
    this.codes.set(name, this.names.length - 1);
    return this.names.length - 1;
  }
}

/** The session a sub-agent's calls count towards: its parent's. */
const sessionOf = (id: string) => id.split("/")[0] ?? id;

export function buildColumns(batches: Iterable<Batch>): Columns {
  const all = [...batches];
  const length = all.reduce((sum, batch) => sum + batch.usages.length, 0);
  const interners = Object.fromEntries(DIMENSIONS.map((dim) => [dim, new Interner()])) as Record<
    Dimension,
    Interner
  >;
  const codes = Object.fromEntries(
    DIMENSIONS.map((dim) => [dim, new Int32Array(length)]),
  ) as Record<Dimension, Int32Array>;
  const cols = {
    ts: new Float64Array(length),
    input: new Float64Array(length),
    cacheWrite: new Float64Array(length),
    cacheRead: new Float64Array(length),
    output: new Float64Array(length),
  };
  const titles = new Map<string, string>();
  let i = 0;
  for (const batch of all) {
    const session = sessionOf(batch.sessionId);
    if (batch.title !== "" && !titles.has(session)) titles.set(session, batch.title);
    for (const usage of batch.usages) {
      cols.ts[i] = usage.ts;
      cols.input[i] = usage.input;
      cols.cacheWrite[i] = usage.cacheWrite;
      cols.cacheRead[i] = usage.cacheRead;
      cols.output[i] = usage.output;
      codes.account[i] = interners.account.code(usage.account);
      codes.model[i] = interners.model.code(usage.model);
      codes.repo[i] = interners.repo.code(batch.repo ?? repoOf(usage.cwd));
      codes.folder[i] = interners.folder.code(
        batch.source === "remote" ? `cloud: ${usage.cwd || "?"}` : folderLabel(usage.cwd),
      );
      codes.source[i] = interners.source.code(batch.source);
      codes.session[i] = interners.session.code(session);
      i += 1;
    }
  }
  const names = Object.fromEntries(DIMENSIONS.map((dim) => [dim, interners[dim].names])) as Record<
    Dimension,
    string[]
  >;
  return { length, codes, names, titles, ...cols };
}
