import { expect, test } from "bun:test";
import { alphabetical } from "../panel/format.js";

test("the hover card lists rows by name, versions in number order, the rest last", () => {
  const rows = [
    { label: "claude-opus-5", value: 1600 },
    { label: "3 more", value: 9, last: true },
    { label: "claude-fable-5-1", value: 641 },
    { label: "claude-opus-5-5", value: 559 },
    { label: "claude-opus-4-8", value: 114 },
    { label: "Claude-sonnet-5", value: 52 },
    { label: "claude-fable-5", value: 19 },
    { label: "claude-haiku-4-5-20251001", value: 5 },
    { label: "claude-opus-10", value: 1 },
  ];
  expect(alphabetical(rows).map((r) => r.label)).toEqual([
    "claude-fable-5",
    "claude-fable-5-1",
    "claude-haiku-4-5-20251001",
    "claude-opus-4-8",
    "claude-opus-5",
    "claude-opus-5-5",
    "claude-opus-10",
    "Claude-sonnet-5",
    "3 more",
  ]);
  expect(rows[0]?.label).toBe("claude-opus-5");
});
