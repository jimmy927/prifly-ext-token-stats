---
setup:
  - bun install --frozen-lockfile
---

A prifly extension run by Bun: the only install is the dev tooling in `package.json`
(Biome, TypeScript, `@types/bun`), pinned by `bun.lock`. There is no build step: the
TypeScript runs as is and `panel/` is plain JS/CSS served as files.

Relies on `bun` being on the PATH outside the worktree. Tests (`bun test`), the typecheck
(`bun run typecheck`) and lint (`bun run check`) need nothing else; the tests read no
real transcripts or prifly data.
