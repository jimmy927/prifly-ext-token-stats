# Token statistics for prifly

A window of how many tokens Claude Code used, and when. It opens from the
**Token statistics** button in prifly's status bar and fills nearly the whole
window.

- **Split by** account, model, repository, folder, local/remote or session, or
  show the total.
- **Measure** output tokens, input + cache writes, cache reads, all tokens, or
  API calls.
- **Time**: ranges from 15 minutes to all history, and buckets from 1 second to
  1 week. Drag across the chart to zoom in. Double-click or Backspace goes
  back, and ←/→ pans. The strip under the chart shows all history; drag on it
  to pick a stretch.
- **Filter** by any value of any dimension. Double-click a legend entry or a
  table row to show only that one; click a legend entry to hide it.
- A table of the stretch on screen (output, input, cache reads, calls,
  sessions, share) and a weekday-by-hour map.

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
