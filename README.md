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

## Forecast

The **View** switch at the far left of the top bar goes between **Usage**
(everything above) and **Forecast**, which asks whether the Claude accounts
connected to prifly will last the week. The choice is saved with the others.
On Forecast the range, bucket, split, measure and chart controls hide, and
the status line says when the accounts' limits were last read.

- **Runway per account**: each account's weekly limit (all models) as a bar —
  solid is spent now, hatched is what it will have spent by its reset at its
  burn, and a thin line marks how much of the week has passed. Then the burn
  in % an hour and where it comes from, when it runs out ("6 h dry before
  reset"), or "Lasts — 25% left over", or "Spent now"; when it resets; and its
  5-hour window. The account new sessions start on is marked. A banner counts
  the accounts spent now and those that run dry before their reset, the
  account-hours with no tokens that leaves, and any account with too few
  readings to tell.
- **Burn-down forecast**: the % of its weekly limit each account has left,
  the last 3 days as read and the next 6 days forecast at its burn: 100% at
  its reset, falling to 0% (the red "empty" line) and back to 100% at its
  next reset. **Whole pool** shows instead what all accounts have left
  together (the sum of each one's % left), each account's share refilling to
  100 at its reset. Readings only minutes apart show as dots. Click a legend
  entry to hide an account. When the transcripts name any weekly window, the
  chart reaches 7 days back, and under the axis each account's lane shows its
  weekly windows (a tick at each reset) with a dot at the minute it ran out —
  Claude Code's first refused call for the weekly limit; hovering a window or
  a dot says which account and when. Before the first reading no % was read,
  so it is reconstructed (`past.ts`), drawn thin and dotted: each window that
  ran out falls from 100% left at its reset to 0% at that minute (a "ran out"
  dot on the empty line), shaped by that window's own cumulative cost with
  Opus 5.5 and Fable counted ×2 (fit on 15–27 Sep 2026: 2.2× and 1.9× Opus
  5), and stays at 0% until its reset; the window an account's first reading
  is in falls the same way to that reading. Whole pool draws them only where
  every account has one. A window that never ran out has no known end and
  stays hatched.
- **Accounts needed**: the pool's burn per day, in % of one account's weekly
  limit, against what the connected accounts refill (100% a week each). Days
  before the readings are reconstructed from the same per-window curves as
  the burn-down's dotted lines and drawn pale; a day where an account has no
  curve (a week that never ran out) is partial, outlined dashed, and its
  hover card names the account. The average of the last 7 or 14 full days,
  read or reconstructed, today and partial days left out, × 7 ÷ 100% is the
  burn in accounts' worth of weekly limit a week, and the card names the
  reconstructed days and the partial ones left out; with the headroom
  slider's margin (20% by default) rounded up, it is how many accounts that
  burn needs.

How it is worked out (`forecast.ts`):

- A **rate** is the rise over the trailing 24 hours of readings, never
  reaching back past the start of the window the latest reading is in. Under
  an hour of readings, it is the latest reading's percent over the hours since
  its window began (every window starts at 0) — "avg since reset" in the
  table, and for an account already at 100 a floor, marked ≥. Only an account
  with no reset, or under an hour into its window, has no rate ("Not enough
  readings yet"); the pool then holds it where it is.
- The **pool** line is drawn at the readings' own times and, ahead, at each
  account's corners, so a reset is a vertical step up of at most 100 and the
  pool never holds more than 100% per account.
- A day's **pool burn** is, over all accounts, each weekly reading's rise over
  the one before it. A reading whose reset is more than an hour later than
  the previous one's is a new window, counted from 0. Before an account's
  first reading, it is that account's reconstructed curve's rise over the day,
  each window again from 0 (`past.ts`).
- Times are local, labelled CET.
- A **weekly-limit refusal** is the synthetic line Claude Code writes for a
  refused call, with `quotaLimits` `seven_day` / `rejected` and its reset
  (`parse.ts`). The transcript's account lags a switch made mid-session, so a
  refusal goes to the account whose current reset it matches a whole number
  of weeks aside, within 30 minutes (`history.ts`); refusals matching no
  account prifly holds are counted in the note, not drawn. A window is shown
  for each account's latest reading's reset and each reset a refusal names;
  none is inferred by adding weeks, since resets move. Remote sessions carry
  no refusals.

**Where the readings come from.** prifly's own usage pollers read each
account's limits; `api.accounts()` hands the extension what they last read,
from memory, at most one new reading every ~5 minutes. Every 5 minutes the
extension asks, and appends a reading of the weekly ("7d") and 5-hour ("5h")
limits of each account whose reading is new to `cache/readings.jsonl`
(`readings.ts`). Readings older than 30 days are dropped. So a rate needs an
hour of readings after the extension starts, and the daily burn fills in over
the days after: an account with no readings yet says "No readings yet — the
first arrives within 5 minutes".

**It needs a prifly with `accounts()`** in its extension contract. On an older
prifly the Forecast view says to update prifly, and the Usage view works as
before.

## Model colours

Split by model, each family has one hue and each version a shade of it:
Opus blue, Fable amber, Sonnet pink and Haiku green. The newest version wears
the full colour and older ones step darker on the light theme, paler on the
dark. Other splits use the ordinary categorical palette, as does a family the
page does not know.

**These are prifly's own colours, not Anthropic's colours for its models.**
Anthropic assigns its models no colours anywhere public, so prifly borrowed
colours Anthropic uses for other things: the brand blue `#6a9bcc` for Opus,
and Claude Code's amber `#ca8a04`, pink `#c46686` and green `#16a34a` for
Fable, Sonnet and Haiku. On the light theme the blue and the amber are
darkened slightly to keep 3:1 against white. prifly's own UI uses the same
palette. The values are in `panel/style.css` and the shade rule is in
`tones.ts`.

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

## Context window simulator

Most of the cost is cache reads: every call sends the whole conversation
again, and a conversation can grow towards a 1M-token window. The
**Context window simulator** panel shows what a smaller window would have
cost. It reads "This is your cost today: $X", then one row per window —
800k, 600k, 400k and 200k tokens — with its cost, the saving in dollars and
per cent, and a bar. Beside it, the same for the stretch on screen. It
follows the filters, so it can answer for one account, model or session.
Today is your own day, from local midnight.

How a call is repriced (`simulate.ts`):

- A call's context is everything it sent: input + cache writes + cache
  reads.
- A call whose context fits the window is unchanged.
- A call over the window is cut to the window, as if the conversation had
  been compacted just before it. The excess comes off the cache reads first,
  then off the cache writes (their 5-minute part first), then off the input.
  Output is unchanged.
- The cut counts are priced with the same table as every other cost here.
  Unpriced models are in no figure.

**This is an estimate, and the most a smaller window could save.** It leaves
out the cost of the compaction calls themselves, the extra turns a smaller
window may need to redo work it forgot, and any change in the quality of the
answers. Hovering a row shows how many calls that window would have cut.

## Where the numbers come from

Every assistant line in a Claude Code transcript carries the API's `usage`
for the call that produced it, timestamped to the millisecond. A call is
counted once, by its message id.

- **Local** sessions are read from `~/.claude/projects`, sub-agents included,
  by a worker thread, so the host never waits on the reading. The first read
  of a few gigabytes takes about 15 seconds. After that only the files that
  grew are read, from where the last read stopped, and a cache,
  `cache/local.sqlite`, keeps the results across host restarts. A scan
  writes only what it read to it — each grown file's new calls — not the
  whole cache. It replaced `cache/local.json`, which is read once into a new
  `local.sqlite` and then no longer used; it can be deleted. Which files
  might have grown comes from watching the folder (inotify): a scan stats
  only those, and lists and stats every transcript on the first scan, every
  ten minutes, and whenever the watch is down, so a change the watch missed
  is at most ten minutes late. The log's `missed` counts such changes.
- **History is kept for good.** Claude Code deletes transcripts older than
  `cleanupPeriodDays` (30 by default). When a transcript goes, what was read
  from it moves to `cache/archive.json` in the extension's folder and keeps
  counting in every chart, split and filter; the status line says how many
  are archived. The archive is a file of its own, so deleting `local.sqlite`
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
- A session started **outside any repository** (`~/src`, `~`, a scratchpad)
  counts towards the repositories it wrote into. Each transcript, the
  session's and each sub-agent's apart, splits its calls in proportion to
  the files its Edit, Write, MultiEdit and NotebookEdit calls wrote into
  each repository; what Bash wrote is not guessed at, and scratch files in no
  repository do not count. A file is placed when it is read, and a removed
  worktree keeps its place (`x.worktrees/y` is x). A transcript that wrote
  into no repository shows as **(no repository)**. The parts of a split call
  add up to it, so every total is unchanged; the Folder split still shows
  the session's own folder.

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
