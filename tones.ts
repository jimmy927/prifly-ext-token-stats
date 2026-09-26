/**
 * Models wear their family's colour: Opus blue, Fable amber, Sonnet pink,
 * Haiku green, a shade per version. The newest version of a family wears the
 * family colour itself; each older one is a step duller and a step further
 * from the chart's surface (darker on the light theme, paler on the dark), so
 * every shade keeps 3:1 against it. The colours are `--m-<family>-<shade>` in
 * `panel/style.css`, where their sources are.
 *
 * The palette is prifly's own choice, also used in prifly's own UI. Anthropic
 * assigns its models no colours; these are colours Anthropic uses for other
 * things (its brand blue, Claude Code's amber, pink and green).
 *
 * A version's shade is its rank among the family's versions in all the data,
 * never among the filtered calls: the same model keeps its shade whatever is
 * shown. A family this does not know, or a version older than the last shade,
 * gets no tone and takes the categorical palette like any other value.
 */

import { familyOf } from "./prices";

export const FAMILIES = ["opus", "fable", "sonnet", "haiku"] as const;
export type Family = (typeof FAMILIES)[number];

/** Shades per family in `panel/style.css`. */
export const SHADES = 3;

export type ModelVersion = { family: Family; version: [number, number] };

const isFamily = (name: string): name is Family => (FAMILIES as readonly string[]).includes(name);

/**
 * `claude-opus-5-5[1m]` is Opus 5.5, `claude-haiku-4-5-20251001` Haiku 4.5,
 * and the older naming `claude-3-5-haiku` Haiku 3.5. Anything else is null.
 */
export function modelVersion(id: string): ModelVersion | null {
  const bare = familyOf(id);
  const current = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?$/.exec(bare);
  const legacy = /^claude-(\d+)(?:-(\d{1,2}))?-([a-z]+)$/.exec(bare);
  const [family, major, minor] =
    current !== null
      ? [current[1], current[2], current[3]]
      : legacy !== null
        ? [legacy[3], legacy[1], legacy[2]]
        : [];
  if (family === undefined || major === undefined || !isFamily(family)) return null;
  return { family, version: [Number(major), minor === undefined ? 0 : Number(minor)] };
}

const newerFirst = (a: [number, number], b: [number, number]) => b[0] - a[0] || b[1] - a[1];

/** Each model name's tone, `opus-0` for the newest Opus, or null for the categorical palette. */
export function modelTones(names: readonly string[]): (string | null)[] {
  const parsed = names.map(modelVersion);
  const versions = new Map<Family, [number, number][]>();
  for (const model of parsed) {
    if (model === null) continue;
    const known = versions.get(model.family) ?? [];
    if (!known.some((v) => newerFirst(v, model.version) === 0)) known.push(model.version);
    versions.set(model.family, known.sort(newerFirst));
  }
  return parsed.map((model) => {
    if (model === null) return null;
    const rank = (versions.get(model.family) ?? []).findIndex(
      (v) => newerFirst(v, model.version) === 0,
    );
    return rank < SHADES ? `${model.family}-${rank}` : null;
  });
}
