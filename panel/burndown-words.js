// The burn-down's words: its subtitle and the note under it (burndown.js
// draws the chart). Both speak of % left, as the chart draws it.

import { clockName, dayName } from "./format.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Whether the chart reaches back for weekly windows: only when the transcripts named any. */
export const reachesBack = (answer) => answer.history.windows.length > 0;

/** The chart's subtitle: how much of it is measured, from the first reading or 3 days back. */
export function burndownSpan(answer) {
  const ms = answer.now - Math.max(answer.firstAt ?? answer.now, answer.grid.from);
  const span =
    ms < HOUR
      ? `${Math.round(ms / 60_000)} min`
      : ms < 2 * DAY
        ? `${Math.round(ms / HOUR)} h`
        : `${Math.round(ms / DAY)} days`;
  const back = !reachesBack(answer)
    ? ""
    : answer.past.curves.length > 0
      ? " · 7 days back, reconstructed from when accounts ran out"
      : " · weekly windows 7 days back";
  return `Weekly % left, ${span} measured, 6 days ahead${back}`;
}

/** What the chart under it draws, in the mode on screen, and how far back the readings go. */
export function burndownNote(mode, answer) {
  const since =
    answer.firstAt >= answer.grid.from
      ? ` Readings began ${dayName(answer.firstAt)} ${clockName(answer.firstAt)} CET, where the ${reachesBack(answer) ? "% lines start" : "chart starts"}; while they span only minutes each is a dot, and accounts read at the same % and minute show as rings round one spot.`
      : "";
  const lines =
    mode === "pool"
      ? `What all ${answer.accounts.length} accounts have left together: the sum of each one's weekly % left, so at most ${answer.accounts.length * 100}%. At an account's reset its share refills to 100 and it burns again at its rate; an account with no rate is held where it is.`
      : "Each line is the % of its weekly limit that account has left: 100% at its reset, falling at its burn, stopping at 0% (empty) and jumping back to 100% at its next reset. An account with no rate has no forecast line.";
  const unplaced = answer.history.unplaced;
  const whose = mode === "pool" ? "the pool's, where every account has one," : "each";
  const rebuilt =
    answer.past.curves.length > 0
      ? ` Before the readings the dotted lines are reconstructed, not read: ${whose} window that ran out falls from 100% left at its reset to 0% at the minute it ran out (a dot) as that window's own cost was spent, Opus 5.5 and Fable counted ×2 (the 15–27 Sep fit gave 2.2× and 1.9× Opus 5), and the window of an account's first reading falls the same way to that reading. The hatching is where no such line exists: a window that never ran out has no known end, and prifly keeps only each account's latest reading.`
      : " The hatching has no %: prifly keeps only each account's latest reading, so none exists before the readings.";
  const past = reachesBack(answer)
    ? ` Under the axis each account's lane shows its weekly windows (a tick at each reset) and a dot at the minute it ran out — Claude Code's first refused call for its weekly limit — from the transcripts.${rebuilt}${unplaced > 0 ? ` ${unplaced} refusal${unplaced === 1 ? "" : "s"} in the last 7 days matched no account prifly holds.` : ""}`
    : "";
  return `${lines}${since}${past}`;
}
