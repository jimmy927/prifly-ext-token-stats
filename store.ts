/**
 * Every call, local and remote, as columns: a timestamp, a code per
 * dimension, the four token counts and the cost. Rebuilt from the per-file results
 * whenever one of them changes — a few hundred thousand rows take
 * milliseconds — and queried by `query.ts`.
 *
 * A row is a call, or a part of one. A call made in a folder that is in no
 * repository (`~/src`) belongs to the repositories its transcript wrote
 * into, split in proportion to the files written into each: one row per
 * repository, its counts and cost scaled by its `share`, so the parts add up
 * to the call. A transcript that wrote into none leaves its call whole, in
 * `NO_REPO`.
 *
 * A row can also be a prompt the reader wrote (`HumanEvent.tokens`): `prompts`
 * 1 and its estimated `promptTokens`, no tokens of a call and a `share` of 0,
 * so it is in no call count. It is placed as a call made then would be, and
 * takes the account and model of its transcript's next call (the one that
 * answered it), or else of its last.
 *
 * Beside the calls, the reader's active time (`Presence`): each present
 * stretch placed in a repository the same way, by the folder and writes of
 * the session the reader replied to next.
 */

import { type HumanEvent, UNKNOWN, type Usage } from "./parse";
import { presenceStretches, type TimelineEvent } from "./presence";
import { costOf, type Price, priceOf } from "./prices";
import { folderLabel, NO_REPO, resolveRepos } from "./where";

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
  /** Files the transcript wrote, by repository: where its calls made in no repository go. */
  writes?: Readonly<Record<string, number>>;
  /** The reader's events in a session's own transcript: the active time (`presence.ts`). */
  human?: readonly HumanEvent[];
};

/**
 * The reader's present stretches (`presence.ts`), a row per stretch and
 * repository: its weight already scaled by the repository's share, as a
 * call's counts are.
 */
export type Presence = {
  length: number;
  from: Float64Array;
  to: Float64Array;
  weight: Float64Array;
  /** Codes into `names`, the repositories' names. */
  repo: Int32Array;
  names: string[];
};

export type Columns = {
  length: number;
  ts: Float64Array;
  codes: Record<Dimension, Int32Array>;
  /** The strings each dimension's codes stand for. */
  names: Record<Dimension, string[]>;
  /** The part of its call a row is: 1, or less for a call split across repositories; 0 for a prompt. */
  share: Float64Array;
  /** The part of a prompt the reader wrote a row is: 0 on a call's row. */
  prompts: Float64Array;
  /** That part of the prompt's estimated tokens. */
  promptTokens: Float64Array;
  /** The counts and the cost below are the row's part of its call's, already scaled by `share`. */
  input: Float64Array;
  cacheWrite: Float64Array;
  /** The part of `cacheWrite` at the 1-hour rate; 0 where it was not kept. */
  cacheWrite1h: Float64Array;
  cacheRead: Float64Array;
  output: Float64Array;
  /** Each call's cost in dollars at API list prices; 0 on an unpriced model. */
  cost: Float64Array;
  /** 1 when the call's model has a price, 0 when it is unpriced. */
  priced: Uint8Array;
  /** Each model code's price, null for an unpriced model: the simulator reprices calls with it. */
  prices: (Price | null)[];
  /** A session's words, by session id: its title. */
  titles: Map<string, string>;
  /** When the reader was in front of Claude, and for which repository. */
  presence: Presence;
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

type Place = readonly [repo: string, share: number];
const NOWHERE: readonly Place[] = [[NO_REPO, 1]];

/** Each repository's part of a transcript's writes, by name; none when it wrote into none. */
export function sharesOf(writes: Readonly<Record<string, number>> | undefined): Place[] {
  const counts = Object.entries(writes ?? {})
    .filter(([, n]) => n > 0)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const total = counts.reduce((sum, [, n]) => sum + n, 0);
  return counts.map(([repo, n]) => [repo, n / total]);
}

/** Where one call goes: its folder's repository, or else its transcript's writes. */
function placesOf(
  batch: Batch,
  cwd: string,
  repos: ReadonlyMap<string, string>,
  shares: readonly Place[],
): readonly Place[] {
  const repo = batch.repo ?? repos.get(cwd) ?? "unknown";
  if (repo !== NO_REPO) return [[repo, 1]];
  return shares.length > 0 ? shares : NOWHERE;
}

/** The columns being filled, a row at a time. */
class Filler {
  readonly interners = Object.fromEntries(DIMENSIONS.map((dim) => [dim, new Interner()])) as Record<
    Dimension,
    Interner
  >;
  readonly codes: Record<Dimension, Int32Array>;
  readonly cols;
  private readonly prices = new Map<string, Price | null>();
  private i = 0;

  constructor(length: number) {
    this.codes = Object.fromEntries(
      DIMENSIONS.map((dim) => [dim, new Int32Array(length)]),
    ) as Record<Dimension, Int32Array>;
    this.cols = {
      ts: new Float64Array(length),
      share: new Float64Array(length),
      prompts: new Float64Array(length),
      promptTokens: new Float64Array(length),
      input: new Float64Array(length),
      cacheWrite: new Float64Array(length),
      cacheWrite1h: new Float64Array(length),
      cacheRead: new Float64Array(length),
      output: new Float64Array(length),
      cost: new Float64Array(length),
      priced: new Uint8Array(length),
    };
  }

  priceFor(model: string): Price | null {
    if (!this.prices.has(model)) this.prices.set(model, priceOf(model));
    return this.prices.get(model) ?? null;
  }

  /** One call, as a row per place it goes to. */
  add(batch: Batch, session: string, usage: Usage, places: readonly Place[]): void {
    const { cols } = this;
    const price = this.priceFor(usage.model);
    const cost = price === null ? 0 : costOf(price, usage);
    for (const [repo, share] of places) {
      const i = this.row(batch, session, usage.account, usage.model, usage.ts, usage.cwd, repo);
      cols.share[i] = share;
      cols.input[i] = usage.input * share;
      cols.cacheWrite[i] = usage.cacheWrite * share;
      cols.cacheWrite1h[i] = (usage.cacheWrite1h ?? 0) * share;
      cols.cacheRead[i] = usage.cacheRead * share;
      cols.output[i] = usage.output * share;
      cols.cost[i] = cost * share;
      cols.priced[i] = price === null ? 0 : 1;
    }
  }

  /**
   * A prompt the reader wrote, as a row per place it goes to, on the account
   * and model of `answer`, the call that answered it. No call's counts: it is
   * priced, at nothing, so it is never among the unpriced calls.
   */
  addPrompt(
    batch: Batch,
    session: string,
    event: HumanEvent,
    answer: Usage | null,
    places: readonly Place[],
  ): void {
    const { cols } = this;
    const account = answer?.account || UNKNOWN;
    const model = answer?.model ?? "unknown";
    this.priceFor(model);
    for (const [repo, share] of places) {
      const i = this.row(batch, session, account, model, event.ts, event.cwd, repo);
      cols.prompts[i] = share;
      cols.promptTokens[i] = (event.tokens ?? 0) * share;
      cols.priced[i] = 1;
    }
  }

  /** The next row, with its time and its place in every dimension; its counts are left at 0. */
  private row(
    batch: Batch,
    session: string,
    account: string,
    model: string,
    ts: number,
    cwd: string,
    repo: string,
  ): number {
    const { cols, codes, interners } = this;
    const i = this.i++;
    cols.ts[i] = ts;
    codes.account[i] = interners.account.code(account);
    codes.model[i] = interners.model.code(model);
    codes.repo[i] = interners.repo.code(repo);
    codes.folder[i] = interners.folder.code(
      batch.source === "remote" ? `cloud: ${cwd || "?"}` : folderLabel(cwd),
    );
    codes.source[i] = interners.source.code(batch.source);
    codes.session[i] = interners.session.code(session);
    return i;
  }
}

/**
 * Every session's events on one timeline, each owned by where a call made
 * then and there would go: its folder's repository, or else its
 * transcript's writes. The present stretches that follow, a row per place.
 */
function presenceOf(all: readonly Batch[], repos: ReadonlyMap<string, string>): Presence {
  const owners: (readonly Place[])[] = [];
  const events: TimelineEvent[] = [];
  for (const batch of all) {
    if (batch.human === undefined || batch.human.length === 0) continue;
    const shares = sharesOf(batch.writes);
    for (const event of batch.human) {
      const owner = owners.push(placesOf(batch, event.cwd, repos, shares)) - 1;
      events.push({ ts: event.ts, lead: event.lead, owner });
    }
  }
  const stretches = presenceStretches(events);
  const length = stretches.reduce((n, s) => n + (owners[s.owner]?.length ?? 0), 0);
  const names = new Interner();
  const out: Presence = {
    length,
    from: new Float64Array(length),
    to: new Float64Array(length),
    weight: new Float64Array(length),
    repo: new Int32Array(length),
    names: names.names,
  };
  let i = 0;
  for (const stretch of stretches) {
    for (const [repo, share] of owners[stretch.owner] ?? []) {
      out.from[i] = stretch.from;
      out.to[i] = stretch.to;
      out.weight[i] = stretch.weight * share;
      out.repo[i] = names.code(repo);
      i++;
    }
  }
  return out;
}

/**
 * The call that answered a prompt made at `ts`: the transcript's first call
 * at or after it, or else its last. `usages` are in the transcript's order,
 * which is time order.
 */
function answerOf(usages: readonly Usage[], ts: number): Usage | null {
  let lo = 0;
  let hi = usages.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((usages[mid]?.ts ?? 0) < ts) lo = mid + 1;
    else hi = mid;
  }
  return usages[lo] ?? usages[usages.length - 1] ?? null;
}

export function buildColumns(batches: Iterable<Batch>): Columns {
  const all = [...batches];
  const repos = resolveRepos(
    all.flatMap((batch) =>
      batch.repo === null
        ? [...batch.usages.map((u) => u.cwd), ...(batch.human ?? []).map((e) => e.cwd)]
        : [],
    ),
  );
  const places = all.map((batch) => {
    const shares = sharesOf(batch.writes);
    return batch.usages.map((usage) => placesOf(batch, usage.cwd, repos, shares));
  });
  const prompts = all.map((batch) => {
    const shares = sharesOf(batch.writes);
    return (batch.human ?? [])
      .filter((event) => event.tokens !== undefined)
      .map((event) => ({ event, places: placesOf(batch, event.cwd, repos, shares) }));
  });
  const rowsOf = (lists: (readonly (readonly Place[])[])[]) =>
    lists.reduce((sum, list) => sum + list.reduce((n, p) => n + p.length, 0), 0);
  const length = rowsOf(places) + rowsOf(prompts.map((list) => list.map((p) => p.places)));
  const filler = new Filler(length);
  const titles = new Map<string, string>();
  for (const [b, batch] of all.entries()) {
    const session = sessionOf(batch.sessionId);
    if (batch.title !== "" && !titles.has(session)) titles.set(session, batch.title);
    for (const [u, usage] of batch.usages.entries()) {
      filler.add(batch, session, usage, places[b]?.[u] ?? NOWHERE);
    }
    for (const { event, places: where } of prompts[b] ?? []) {
      filler.addPrompt(batch, session, event, answerOf(batch.usages, event.ts), where);
    }
  }
  const names = Object.fromEntries(
    DIMENSIONS.map((dim) => [dim, filler.interners[dim].names]),
  ) as Record<Dimension, string[]>;
  const prices = names.model.map((model) => filler.priceFor(model));
  const presence = presenceOf(all, repos);
  return { length, codes: filler.codes, names, titles, prices, presence, ...filler.cols };
}
