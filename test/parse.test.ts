import { expect, test } from "bun:test";
import { Answerer, readParams } from "../answer";
import { accountAt, freshState, readText, UNKNOWN } from "../parse";
import { buildColumns } from "../store";
import { repoOfUrl, resolveRepos } from "../where";

const context = (email: string, at: string) =>
  JSON.stringify({
    type: "attachment",
    timestamp: at,
    attachment: { type: "session_context", text: `The user's email address is ${email}.` },
  });
const call = (id: string, at: string, output: number, model = "claude-opus-5-5") =>
  JSON.stringify({
    type: "assistant",
    timestamp: at,
    requestId: `r${id}`,
    cwd: "/tmp/x",
    message: {
      id,
      model,
      usage: { input_tokens: 1, cache_read_input_tokens: 10, output_tokens: output },
    },
  });

test("each call goes to the account last named, and a call's repeated lines count once", () => {
  const state = freshState();
  const text = [
    call("m0", "2026-09-01T00:00:00Z", 5),
    context("a@x.com", "2026-09-02T00:00:00Z"),
    call("m1", "2026-09-02T01:00:00Z", 7),
    call("m1", "2026-09-02T01:00:00Z", 7),
    context("b@x.com", "2026-09-03T00:00:00Z"),
    call("m2", "2026-09-03T01:00:00Z", 9),
    JSON.stringify({
      type: "assistant",
      timestamp: "2026-09-03T02:00:00Z",
      message: { model: "<synthetic>", usage: {} },
    }),
    '{"type":"assistant","truncat',
  ].join("\n");
  const usages = readText(state, text);
  expect(usages.map((u) => [u.account, u.output])).toEqual([
    [UNKNOWN, 5],
    ["a@x.com", 7],
    ["b@x.com", 9],
  ]);
  expect(accountAt(state.segments, Date.parse("2026-09-02T12:00:00Z"))).toBe("a@x.com");
  expect(accountAt(state.segments, Date.parse("2026-09-01T12:00:00Z"))).toBe("");
});

test("an answer splits, buckets and filters", () => {
  const state = freshState();
  const usages = readText(
    state,
    [
      context("a@x.com", "2026-09-02T00:00:00Z"),
      call("1", "2026-09-02T00:10:00Z", 100),
      call("2", "2026-09-02T00:20:00Z", 50, "claude-sonnet-5"),
      context("b@x.com", "2026-09-02T00:30:00Z"),
      call("3", "2026-09-02T01:10:00Z", 20),
    ].join("\n"),
  );
  const cols = buildColumns([{ sessionId: "s1", title: "t", source: "local", repo: "r", usages }]);
  const answerer = new Answerer(cols);
  const hour = readParams(
    {
      from: String(Date.parse("2026-09-02T00:00:00Z")),
      to: String(Date.parse("2026-09-02T02:00:00Z")),
      bucket: "3600000",
      split: "account",
      metric: "output",
    },
    0,
  );
  const answer = answerer.answer(hour);
  expect(answer.buckets.length).toBe(2);
  expect(answer.series.map((s) => [s.key, s.values])).toEqual([
    ["a@x.com", [150, 0]],
    ["b@x.com", [0, 20]],
  ]);
  const sonnet = answerer.answer({
    ...hour,
    split: "model",
    filters: { model: ["claude-sonnet-5"] },
  });
  expect(sonnet.series.map((s) => s.total)).toEqual([50]);
  expect(answer.rows.find((r) => r.key === "a@x.com")).toMatchObject({
    calls: 2,
    cacheRead: 20,
    sessions: 1,
  });
});

test("a repository URL is named by its last part", () => {
  expect(repoOfUrl("https://github.com/jimmy927/prifly.git")).toBe("prifly");
  expect(repoOfUrl("git@github.com:jimmy927/prifly-ext-sentry.git")).toBe("prifly-ext-sentry");
});

test("a deleted clone is the repository its name, less a number, names", () => {
  const repos = resolveRepos([
    "/nowhere/odi3",
    "/nowhere/odi2.worktrees/x",
    "/nowhere/web3",
    "/tmp",
  ]);
  // Nothing live here is called odi or web: the names stand.
  expect(repos.get("/nowhere/odi3")).toBe("odi3");
  expect(repos.get("/nowhere/web3")).toBe("web3");
});
