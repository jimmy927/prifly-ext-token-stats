import { afterEach, expect, test } from "bun:test";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { missedBy, Transcripts } from "../transcripts";

const dirs: string[] = [];
const opened: Transcripts[] = [];
afterEach(() => {
  for (const transcripts of opened.splice(0)) transcripts.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A projects root: one project with a session and its sub-agent, and a symlink repeating it. */
function projects(): string {
  const root = mkdtempSync(join(tmpdir(), "token-stats-transcripts-"));
  dirs.push(root);
  mkdirSync(join(root, "p", "s1", "subagents"), { recursive: true });
  writeFileSync(join(root, "p", "s1.jsonl"), "{}\n");
  writeFileSync(join(root, "p", "s1", "subagents", "agent-a.jsonl"), "{}\n");
  writeFileSync(join(root, "p", "s1", "custom-title.json"), "{}");
  writeFileSync(join(root, "stray.jsonl"), "{}\n");
  symlinkSync(join(root, "p"), join(root, "link"));
  return root;
}

function watching(root: string, clock = { now: 0 }) {
  const transcripts = new Transcripts(root, 600_000, () => clock.now);
  opened.push(transcripts);
  return { transcripts, clock };
}

/** inotify delivers on the event loop: give it a turn. */
const settle = () => Bun.sleep(150);

test("the first scan lists every transcript, sessions apart from sub-agents", () => {
  const root = projects();
  const selection = watching(root).transcripts.select();
  expect(selection.full).toBe(true);
  expect(selection.main).toEqual([join(root, "p", "s1.jsonl")]);
  expect(selection.agents).toEqual([join(root, "p", "s1", "subagents", "agent-a.jsonl")]);
  expect(selection.flagged).toBeNull();
  // The root, p, p/s1 and p/s1/subagents.
  expect(selection.dirs).toBe(4);
});

test("with nothing written, a scan stats nothing", async () => {
  const { transcripts } = watching(projects());
  transcripts.select();
  await settle();
  const selection = transcripts.select();
  expect(selection).toMatchObject({ full: false, main: [], agents: [], gone: [], dirs: 0 });
  expect(selection.statted).toBe(0);
});

test("a transcript appended to is the only one stat'ed", async () => {
  const root = projects();
  const { transcripts } = watching(root);
  transcripts.select();
  appendFileSync(join(root, "p", "s1", "subagents", "agent-a.jsonl"), "{}\n");
  await settle();
  const selection = transcripts.select();
  expect(selection.full).toBe(false);
  expect(selection.main).toEqual([]);
  expect(selection.agents).toEqual([join(root, "p", "s1", "subagents", "agent-a.jsonl")]);
});

test("a new session folder is listed whole, however fast it was filled", async () => {
  const root = projects();
  const { transcripts } = watching(root);
  transcripts.select();
  mkdirSync(join(root, "q", "s2", "subagents"), { recursive: true });
  writeFileSync(join(root, "q", "s2.jsonl"), "{}\n");
  writeFileSync(join(root, "q", "s2", "subagents", "agent-b.jsonl"), "{}\n");
  await settle();
  const selection = transcripts.select();
  expect(selection.main).toEqual([join(root, "q", "s2.jsonl")]);
  expect(selection.agents).toEqual([join(root, "q", "s2", "subagents", "agent-b.jsonl")]);
});

test("removed files and folders are reported gone; other files are not listed", async () => {
  const root = projects();
  const { transcripts } = watching(root);
  transcripts.select();
  rmSync(join(root, "p", "s1.jsonl"));
  rmSync(join(root, "p", "s1"), { recursive: true });
  writeFileSync(join(root, "p", "notes.txt"), "");
  writeFileSync(join(root, "top.jsonl"), "{}\n");
  await settle();
  const selection = transcripts.select();
  expect(selection.gone).toContain(join(root, "p", "s1.jsonl"));
  expect(selection.gone).toContain(join(root, "p", "s1"));
  expect(selection.main).toEqual([]);
  expect(selection.agents).toEqual([]);
});

test("a renamed transcript is gone under its old name and found under the new", async () => {
  const root = projects();
  const { transcripts } = watching(root);
  transcripts.select();
  renameSync(join(root, "p", "s1.jsonl"), join(root, "p", "s3.jsonl"));
  await settle();
  const selection = transcripts.select();
  expect(selection.gone).toEqual([join(root, "p", "s1.jsonl")]);
  expect(selection.main).toEqual([join(root, "p", "s3.jsonl")]);
});

test("every ten minutes a scan is a full pass, and carries what the watcher named", async () => {
  const root = projects();
  const { transcripts, clock } = watching(root);
  transcripts.select();
  appendFileSync(join(root, "p", "s1.jsonl"), "{}\n");
  await settle();
  clock.now = 600_000;
  const selection = transcripts.select();
  expect(selection.full).toBe(true);
  expect(selection.main).toEqual([join(root, "p", "s1.jsonl")]);
  expect(selection.agents).toHaveLength(1);
  expect(selection.flagged).toEqual(new Set(["p/s1.jsonl"]));
  expect(transcripts.select().full).toBe(false);
});

test("a changed file counts as missed unless it or a folder above it was named", () => {
  const root = "/r";
  const flagged = new Set(["p/a.jsonl", "q/s2"]);
  expect(missedBy(root, flagged, ["/r/p/a.jsonl"])).toBe(0);
  expect(missedBy(root, flagged, ["/r/q/s2/subagents/b.jsonl"])).toBe(0);
  expect(missedBy(root, flagged, ["/r/p/b.jsonl", "/r/q/s1.jsonl"])).toBe(2);
});
