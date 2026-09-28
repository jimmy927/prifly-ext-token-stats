import { afterEach, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Answerer, readParams } from "../answer";
import type { FileOut } from "../archive";
import { freshState, readText } from "../parse";
import type { ScanReply, ScanRequest } from "../scan-worker";
import { buildColumns } from "../store";
import { NO_REPO, repoOfPath, resolveRepos } from "../where";

const AT = "2026-09-27T12:00:00Z";

/** One call, with the tool calls it made: `[tool, path]`. */
const call = (id: string, cwd: string, output: number, tools: [string, string][] = []) =>
  JSON.stringify({
    type: "assistant",
    timestamp: AT,
    requestId: `r${id}`,
    cwd,
    message: {
      id,
      model: "claude-opus-5-5",
      usage: { input_tokens: 1000, cache_read_input_tokens: 9000, output_tokens: output },
      content: tools.map(([name, path], k) => ({
        type: "tool_use",
        id: `${id}-${k}`,
        name,
        input: name === "Bash" ? { command: `echo > ${path}` } : { file_path: path },
      })),
    },
  });

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * `src/` in no repository, holding `alpha` (origin github.com/o/alpha), a
 * worktree of it at `alpha.worktrees/feat`, and `beta` (no origin).
 */
function checkouts() {
  const dir = mkdtempSync(join(tmpdir(), "token-stats-repos-"));
  dirs.push(dir);
  const src = join(dir, "src");
  const alpha = join(src, "alpha");
  const beta = join(src, "beta");
  const feat = join(src, "alpha.worktrees", "feat");
  mkdirSync(join(alpha, ".git", "worktrees", "feat"), { recursive: true });
  writeFileSync(
    join(alpha, ".git", "config"),
    '[remote "origin"]\n\turl = git@github.com:o/alpha.git\n',
  );
  mkdirSync(join(beta, ".git"), { recursive: true });
  mkdirSync(feat, { recursive: true });
  writeFileSync(join(feat, ".git"), `gitdir: ${alpha}/.git/worktrees/feat\n`);
  const scratch = join(dir, "scratchpad");
  mkdirSync(scratch);
  return { dir, src, alpha, beta, feat, scratch };
}

function scanWith(worker: Worker, request: ScanRequest): Promise<ScanReply> {
  return new Promise((resolve) => {
    worker.onmessage = (event: MessageEvent<ScanReply>) => resolve(event.data);
    worker.postMessage(request);
  });
}

/** The panel's answer over the transcripts, split `split`, as `index.ts` builds it. */
function answer(files: Iterable<FileOut>, split: string, metric = "cost") {
  const batches = [...files].map((file) => ({
    sessionId: file.sessionId,
    title: file.title,
    source: "local" as const,
    repo: null,
    usages: file.usages,
    ...(file.writes === undefined ? {} : { writes: file.writes }),
  }));
  const at = Date.parse(AT);
  const params = readParams(
    { from: String(at - 3_600_000), to: String(at + 3_600_000), split, metric },
    0,
  );
  return new Answerer(buildColumns(batches)).answer(params);
}

const byKey = (rows: { key: string; cost: number }[]) =>
  Object.fromEntries(rows.map((row) => [row.key, row.cost]));

test("a no-repo session's sub-agent splits its calls by the files it wrote into each repo", async () => {
  const { dir, src, alpha, beta, feat, scratch } = checkouts();
  const project = join(dir, "projects", "-src");
  mkdirSync(join(project, "s1", "subagents"), { recursive: true });
  mkdirSync(join(project, "s2", "subagents"), { recursive: true });
  // The session itself, in `src`, writes nothing.
  writeFileSync(join(project, "s1.jsonl"), `${call("m1", src, 100)}\n`);
  // Three files into alpha (one in its worktree), one into beta; a scratch file and Bash count for none.
  const writer = join(project, "s1", "subagents", "agent-w.jsonl");
  writeFileSync(
    writer,
    [
      call("w1", src, 1000, [
        ["Write", join(alpha, "a.ts")],
        ["Edit", join(feat, "src", "f.ts")],
      ]),
      call("w2", src, 1000, [
        ["MultiEdit", join(alpha, "b.ts")],
        ["Write", join(beta, "x.ts")],
        ["Write", join(scratch, "notes.md")],
        ["Bash", join(beta, "y.ts")],
      ]),
      "",
    ].join("\n"),
  );
  // A sub-agent that only read goes to no repository.
  writeFileSync(join(project, "s1", "subagents", "agent-r.jsonl"), `${call("r1", src, 400)}\n`);
  // A session in beta stays with beta, whatever it wrote.
  writeFileSync(
    join(project, "s2.jsonl"),
    `${call("b1", beta, 700, [["Write", join(alpha, "z.ts")]])}\n`,
  );

  const request: ScanRequest = {
    type: "scan",
    root: join(dir, "projects"),
    cacheFile: join(dir, "cache", "local.json"),
    archiveFile: join(dir, "cache", "archive.json"),
  };
  const worker = new Worker(new URL("../scan-worker.ts", import.meta.url).href);
  const files = new Map((await scanWith(worker, request)).files.map((f) => [f.path, f]));
  expect(files.get(writer)?.writes).toEqual({ alpha: 3, beta: 1 });

  const before = answer(files.values(), "repo");
  const whole = answer(files.values(), "none");
  const cost = (output: number) => (1000 * 4 + 9000 * 0.2 + output * 20) / 1e6;
  const repos = byKey(before.rows);
  expect(repos["alpha"]).toBeCloseTo(cost(1000) * 2 * 0.75, 12);
  expect(repos[NO_REPO]).toBeCloseTo(cost(100) + cost(400), 12);
  expect(repos["beta"]).toBeCloseTo(cost(1000) * 2 * 0.25 + cost(700), 12);
  expect(Object.keys(repos).sort()).toEqual([NO_REPO, "alpha", "beta"]);
  // The folder split is untouched: every call made in `src` is still there.
  expect(before.rows.length).toBe(3);
  expect(answer(files.values(), "folder").rows.map((r) => r.calls)).toEqual([4, 1]);

  // Totals: the parts add up to the calls, in the table, the chart and the simulator.
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  expect(sum(before.rows.map((r) => r.cost))).toBeCloseTo(whole.rows[0]?.cost ?? -1, 12);
  expect(sum(before.series.map((s) => s.total))).toBeCloseTo(whole.series[0]?.total ?? -1, 12);
  expect(sum(before.rows.map((r) => r.calls))).toBeCloseTo(5, 12);
  const callSeries = answer(files.values(), "repo", "calls").series;
  expect(sum(callSeries.map((s) => s.total))).toBeCloseTo(5, 12);
  expect(before.simulation.stretch.actual).toBeCloseTo(whole.simulation.stretch.actual, 12);
  expect(before.simulation.stretch.calls).toBeCloseTo(5, 12);

  // The worktree is removed and the transcript grows: what was counted stays counted.
  rmSync(join(src, "alpha.worktrees"), { recursive: true });
  appendFileSync(writer, `${call("w3", src, 10)}\n`);
  const grown = (await scanWith(worker, request)).files.find((f) => f.path === writer);
  expect(grown?.writes).toEqual({ alpha: 3, beta: 1 });
  worker.terminate();
});

test("a file that is gone is placed by what is left of its checkout, or by its path", () => {
  const { dir, src, alpha, scratch } = checkouts();
  // Removed since: a worktree, a file of a live checkout, a nested agent worktree.
  expect(repoOfPath(join(src, "alpha.worktrees", "gone", "src", "f.ts"))).toBe("alpha");
  expect(repoOfPath(join(alpha, "deleted", "old.ts"))).toBe("alpha");
  expect(repoOfPath(join(alpha, ".claude", "worktrees", "agent-q", "f.ts"))).toBe("alpha");
  // Its main checkout gone too: the worktree's naming is all there is.
  expect(repoOfPath(join(dir, "nowhere", "gamma.worktrees", "x", "f.ts"))).toBe("gamma");
  // Scratch files, there or gone, are in no repository.
  expect(repoOfPath(join(scratch, "notes.md"))).toBeNull();
  expect(repoOfPath(join(dir, "gone-scratch", "notes.md"))).toBeNull();
  // A session's folder: a worktree's leftover folder is still its repository's, `src` is in none.
  const leftover = join(src, "alpha.worktrees", "leftover");
  mkdirSync(leftover, { recursive: true });
  const repos = resolveRepos([leftover, src]);
  expect([repos.get(leftover), repos.get(src)]).toEqual(["alpha", NO_REPO]);
});

test("only the file-writing tools' paths count as writes, once each", () => {
  const state = freshState();
  readText(
    state,
    [
      call("m1", "/src", 1, [
        ["Write", "/src/a/x.ts"],
        ["Read", "/src/a/y.ts"],
        ["Bash", "/src/a/z.ts"],
      ]),
      JSON.stringify({
        type: "assistant",
        timestamp: AT,
        requestId: "rm1",
        message: {
          id: "m1",
          model: "claude-opus-5-5",
          usage: { output_tokens: 1 },
          content: [
            { type: "tool_use", name: "NotebookEdit", input: { notebook_path: "/n.ipynb" } },
          ],
        },
      }),
    ].join("\n"),
  );
  // The second line repeats call m1 but carries a tool call of its own.
  expect(state.written).toEqual(["/src/a/x.ts", "/n.ipynb"]);
});
