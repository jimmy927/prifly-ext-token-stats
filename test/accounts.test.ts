import { expect, test } from "bun:test";
import { decodeArchive, encodeArchive, type FileOut } from "../archive";
import { UNKNOWN } from "../parse";
import { accountFor, buildColumns } from "../store";

const T0 = Date.parse("2026-10-05T10:00:00Z");

const file = (model: string, account: string): FileOut => ({
  path: "/p/s1.jsonl",
  sessionId: "s1",
  parentId: null,
  title: "t",
  usages: [
    {
      ts: T0 + 60_000,
      account,
      model,
      cwd: "/src/x",
      input: 1,
      cacheWrite: 0,
      cacheRead: 0,
      output: 1,
    },
  ],
  human: [{ ts: T0, lead: 0, cwd: "/src/x", tokens: 10 }],
});

/** The accounts the rows of a session's call and its prompt are listed under. */
function accountsOf(f: FileOut): string[] {
  const { usages, human = [] } = f;
  const cols = buildColumns([
    { sessionId: "s1", title: "t", source: "local", repo: null, usages, human },
  ]);
  return [...cols.codes.account].map((c) => cols.names.account[c] ?? "");
}

test("a call with no account is listed under its provider", () => {
  expect(accountsOf(file("moonshotai/Kimi-K3", UNKNOWN))).toEqual(["moonshotai", "moonshotai"]);
  expect(accountsOf(file("zai-org/GLM-5.2", ""))).toEqual(["zai-org", "zai-org"]);
  expect(accountFor(undefined, "glm-5.2")).toBe("other provider");
});

test("a Claude call with no account stays not recorded", () => {
  for (const model of [
    "claude-opus-5-5",
    "claude-sonnet-5",
    "us.anthropic.claude-opus-4-1-20250805-v1:0",
    "anthropic/claude-sonnet-4-5",
    "<synthetic>",
    "unknown",
    "",
  ]) {
    expect(accountsOf(file(model, UNKNOWN))).toEqual([UNKNOWN, UNKNOWN]);
  }
});

test("a recorded email stays, whatever the model", () => {
  expect(accountsOf(file("moonshotai/Kimi-K3", "me@x.com"))).toEqual(["me@x.com", "me@x.com"]);
});

test("an archived call is decided when the columns are built", () => {
  const archived = decodeArchive(
    JSON.parse(JSON.stringify(encodeArchive([file("moonshotai/Kimi-K3", UNKNOWN)]))),
  )?.[0];
  expect(archived?.usages[0]?.account).toBe(UNKNOWN);
  expect(accountsOf(archived as FileOut)).toEqual(["moonshotai", "moonshotai"]);
});
