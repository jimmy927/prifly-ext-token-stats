# Token statistics for prifly

A window of how many tokens Claude Code used, and when. It opens from the
**Token statistics** button in prifly's status bar and fills nearly the whole
window.

- **Split by** account, model, repository, folder, local/remote or session, or
  show the total.
- **Measure** cost (the default), output tokens, input + cache writes, cache
  reads, all tokens, or API calls.
- **Time**: ranges from 15 minutes to all history, and buckets from 1 second to
  1 week. Drag across the chart to zoom in. Double-click or Backspace goes
  back, and ←/→ pans. The strip under the chart shows all history; drag on it
  to pick a stretch.
- **Filter** by any value of any dimension. Double-click a legend entry or a
  table row to show only that one; click a legend entry to hide it.
- A table of the stretch on screen (cost, output, input, cache reads, calls,
  sessions, share) and a weekday-by-hour map.

## Cost

Tokens are not comparable across models: a Fable output token costs ten
times a Haiku one. So the main measure is **cost**, what each call would have
cost at Anthropic's API list prices, in US dollars. Each call is priced at its
own model's rates for input, cache writes (the 5-minute and the 1-hour rate
apart, as the API reports them in `usage.cache_creation`), cache reads and
output. The prices are in `prices.ts`, taken from
<https://platform.claude.com/docs/en/about-claude/pricing> and checked on
2026-09-26; dated ids such as `claude-haiku-4-5-20251001` and `[1m]` suffixes
count as their model.

- **On a subscription this is value used, not money billed.** A Pro or Max
  plan pays a flat fee; the cost here is what the same calls would have cost
  on the API.
- A model with no price in the table is **unpriced**: its calls are in no
  cost, and the page names them under the title rather than counting them as
  $0.
- Calls read before the 5-minute/1-hour split was kept (the archive, and
  cloud sessions read earlier) have all their cache writes priced at the
  5-minute rate, so their cost is a lower bound.
- Not priced: fast mode, US-only inference and the batch discount, none of
  which Claude Code's transcripts show in use. The pricing page lists no
  long-context rate for current models.

## Where the numbers come from

Every assistant line in a Claude Code transcript carries the API's `usage`
for the call that produced it, timestamped to the millisecond. A call is
counted once, by its message id.

- **Local** sessions are read from `~/.claude/projects`, sub-agents included,
  by a worker thread, so the host never waits on the reading. The first read
  of a few gigabytes takes about 15 seconds. After that only the files that
  grew are read, from where the last read stopped, and a cache in `cache/`
  keeps the results across host restarts.
- **History is kept for good.** Claude Code deletes transcripts older than
  `cleanupPeriodDays` (30 by default). When a transcript goes, what was read
  from it moves to `cache/archive.json` in the extension's folder and keeps
  counting in every chart, split and filter; the status line says how many
  are archived. The archive is a file of its own, so deleting `local.json`
  only makes the next read slower. If an archived transcript comes back to
  the same path, the file is counted and its archived copy dropped. Remote
  sessions likewise stay counted after they leave the API's listing.
- **Remote** sessions (Claude Code on the web) are read through prifly's
  connected Claude accounts, each with its own token. A session is fetched
  again only when it has changed since.
- **Account**: Claude Code writes the logged-in email into a transcript when a
  session starts or resumes, and has done so since early September 2026.
  Each call counts towards the last email named before it. If you log in as
  someone else mid-session, the switch shows at the next resume, not at the
  login. Calls from before any email was recorded show as "not recorded".
  A sub-agent's calls count towards the account its parent session was on at
  the time.
- **Repository** is the checkout's origin, so worktrees and extra clones of
  one repository count as that repository. **Folder** is the session's
  working directory.

## Install

In prifly: Extensions → install from `https://github.com/jimmy927/prifly-ext-token-stats`,
or link a checkout into `~/.local/share/prifly/extensions/`, then enable it.

## Writing a window of your own

This extension is the example for prifly's `panels`. A panel is a button in
the status bar that opens your page over nearly the whole window.

1. In `prifly-extension.json`, name the panel and the folder its page is in.
   Only that folder is served, so config and tokens beside it stay private:

   ```json
   "panels": [
     { "id": "stats", "label": "Token statistics", "icon": "chart",
       "description": "Shown on hover", "folder": "panel", "page": "index.html" }
   ]
   ```

2. Your page fetches `api/<anything>` relative to itself. The host calls your
   module's `panel` export and sends back what it returns as JSON. If it
   throws, the page gets a 500 with `{ "error": message }`.

   ```ts
   export async function panel(panelId: string, request: PanelRequest) {
     // request.path: "stats"; request.query: the URL's query; request.body: a POST's JSON
     return { hello: "world" };
   }
   ```

3. To match prifly's look, read `?theme=dark|light` from the page's URL
   before the first paint. Once loaded, the page also gets a `message` event
   `{ type: "prifly-look", dark, tokens }`. `tokens` holds the window's CSS
   variables (`--background`, `--foreground`, `--border`, `--font-sans`, …),
   including those of any skin or theme in use.

Other things an extension gets: `api.cloud.sessions()` and
`api.cloud.transcript(account, id)` read the cloud sessions of every Claude
account connected to prifly. See `prifly-api.ts` for the whole contract.

## Develop

```sh
bun install
bun test && bun run typecheck && bun run check
```
