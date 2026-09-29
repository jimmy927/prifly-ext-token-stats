// What the reader can choose between: the time ranges and bucket widths,
// what to split by and measure, and how to draw it.

export const SEC = 1000;
export const MIN = 60 * SEC;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;

export const RANGES = [
  ["15m", 15 * MIN],
  ["1h", HOUR],
  ["6h", 6 * HOUR],
  ["24h", DAY],
  ["3d", 3 * DAY],
  ["7d", 7 * DAY],
  ["30d", 30 * DAY],
  ["90d", 90 * DAY],
  ["All", 0],
];
export const BUCKETS = [
  0,
  SEC,
  5 * SEC,
  15 * SEC,
  30 * SEC,
  MIN,
  5 * MIN,
  15 * MIN,
  30 * MIN,
  HOUR,
  3 * HOUR,
  6 * HOUR,
  12 * HOUR,
  DAY,
  7 * DAY,
];
export const SPLITS = [
  ["account", "Account"],
  ["model", "Model"],
  ["repo", "Repository"],
  ["folder", "Folder"],
  ["source", "Local/remote"],
  ["session", "Session"],
  ["none", "Total"],
];
export const METRICS = [
  ["cost", "Cost"],
  ["output", "Output"],
  ["input", "Input + cache writes"],
  ["cacheRead", "Cache reads"],
  ["all", "All tokens"],
  ["calls", "API calls"],
];
export const METRIC_ROW = {
  cost: "cost",
  output: "output",
  input: "input",
  cacheRead: "cacheRead",
  all: "output",
  calls: "calls",
};
export const KINDS = [
  ["bars", "Bars"],
  ["lines", "Lines"],
];
