# Sales Pipeline

A one-screen sales pipeline for a 20-person team working ~50,000 shared deals, built around what happens when
saves fail, the network is slow, and teammates change things under you.

* **Video walkthrough:** [https://youtu.be/SgyuJjSM8as](https://youtu.be/SgyuJjSM8as)
* **Live demo:** [https://shashikanth101.github.io/gohighlevel-assignment/](https://shashikanth101.github.io/gohighlevel-assignment/)

```bash
npm install && npm run dev      # http://localhost:5173
```

`npm test` (142 tests) · `npm run typecheck` · `npm run build`. URL params: `?size=50000` (100–200,000) and
`?seed=42`. There is no backend: a fake server inside the app, behind an `Api` interface, holds the data. Everything
is seeded, so the same seed and the same actions replay the same data and the same failures.

## What I built and why

The app opens on **Today**: my open deals that have a reason to be worked on, ranked, with the reason on every row
("Overdue 6d", "Stuck 14d", "High value"), followed by what I closed in the last 7 days. With seed 42 that is 1,299
of my 2,423 deals. It is built around five problems:

| Problem | What the app does |
|---|---|
| I don't know what to work on | A ranked Today list from a pure, unit-tested `priority()`; every row says why it is there |
| I moved a deal, it didn't save, nobody told me | Optimistic updates with a status per deal, quiet retries, and a failure state that stays until you resolve it |
| Deals keep jumping around | The list is a snapshot; teammates' changes never reorder or remove a row until you ask |
| I need to move thousands to Lost | Select all matching, then a chunked, cancellable, retryable, undoable job |
| I can't use a mouse for long | A small, fixed keyboard map; every action also has a visible control |

I spent most of the time on the sync engine and its failure behaviour, and less on screens. The fake server has a
Dev Panel that makes it slow, flaky, offline or noisy, so each behaviour below can be triggered and watched.

## Key UX decisions, and what I rejected

| Decision | Why | Rejected |
|---|---|---|
| A virtualized table, not a board | A 10,000-card column can't be scanned; drag is mouse-only; bulk moves across columns are awkward | Kanban board; drag onto the stage rail |
| Today shows its reasons as chips, in a fixed order (High value, overdue, closing soon, stuck) | The ranking is explainable and checkable | An opaque score |
| A failed save keeps showing what you asked for, marked **Not saved**, with Retry / Revert | A silent revert is the original complaint | A modal per failure; toast-only; blocking spinners; silent rollback |
| The list is a snapshot of ids, rebuilt only when *I* act | Rows under the cursor must not move | Live-sorting the list as data arrives |
| A move that no longer matches the filter removes the row and focus advances | Triage flow. It stays tracked in the sync tray and the Failed view, so a failure can't hide | Leaving ghost rows behind |
| A stage in the rail filters the view you are in (also in Today); counts follow that scope | The count you click is the number of rows you get | Jumping to another view on click |
| Confirm only moves to Lost above 50 deals, with exact counts; everything else is undoable | Confirmation dialogs get ignored if they appear everywhere | Confirming every move |
| Won/Lost deals show closed-deal fields: Next step "—", Close "Closed 3d ago" | A closed deal has nothing to act on, and "in 5d" next to "Won" is wrong | Reusing the open-deal columns |
| An always-visible detail panel with stage buttons and the value field; no per-row buttons | One clear place to act on the focused deal; row buttons got clipped | Hover-only or per-row controls |

## Failed saves

Each deal has one request in flight; later edits queue behind it and coalesce. A transport failure is retried twice
(400 ms, then 1.2 s) with the same idempotency key, then the row is marked **Not saved** and keeps the value you chose.

The fake server fails in two ways, because they behave differently: rejected before applying (about 70% of failures)
and applied but the response was lost (about 30%). The second is the dangerous one, since a naive retry would apply
the change twice. The server stores results by idempotency key and replays them, and a test asserts exactly one
application. A failed write blocks later writes to the same deal, so they can't overtake it.

A failure is shown four ways: the sync tray turns red and stays red, the Failed tab gets a badge, a persistent toast
offers Retry, and an `aria-live="assertive"` message is set. The tray has Retry all, Discard all and per-item
actions. The browser warns on reload while anything is unsaved. Failures that were only "offline" retry on their own
when the connection returns. Creating a deal ("+ New deal", `N`) goes through the same path under a temporary id.
Bulk jobs report partial failures per deal and offer Retry failed, Cancel and Undo.

## Teammates' changes

The fake server edits deals as other users, and the app polls its change feed every 2 s.

* A change that doesn't affect the current filter or sort patches the row in place with a brief highlight.
* A change that would move or remove a row waits behind **"N updates from teammates · Show"**. The focused row and
  the selection stay pinned when you apply it. My own writes echoing back never raise the pill.
* Stage-rail counts update live because they move nothing.
* If a teammate edits a deal I have a pending save for, the save gets a version conflict. Each write carries the
  pre-edit values of the fields it touches: if the teammate changed other fields, it rebases silently and resends;
  if they changed the same field, the row shows "Arjun moved this to Lost" with **Keep mine / Take theirs**.
* Bulk moves are last-write-wins (see limits).

## Performance

Measured on the production build (`npm run build`, served with `vite preview`), 50,000 deals, seed 42.

* **Machine:** Intel Core i5-9300H (4 cores / 8 threads), 3 GB RAM visible to WSL2, Linux 5.15 (WSL2), Node 20.20.2.
* **Browser:** Chromium 156 (headless shell) driven by Playwright 1.65.1, 1440×800. Its WebGL renderer reports
  SwiftShader, so rendering is in software, which makes paint times pessimistic.
* **Method:** 5 fresh page loads. Timings come from the app's own `performance.measure` entries (`pipeline:*`); the
  "painted" ones stop two animation frames after the work. Samples are pooled where one load produced several. After
  loading, simulated failures and teammate changes were switched off. The script is not committed.

| Target | Measured, median [min–max] |
|---|---|
| First render after data < 1 s | **18 ms** [17–28] after the last chunk. Loading all 50k takes 1.65 s [1.65–1.67], almost all of it the fake server's simulated 80–200 ms per 5,000-deal chunk |
| Filter change < 150 ms | **29 ms** [25–63] to painted (40 samples); the view build alone is 9 ms [5–46] |
| Sort change < 150 ms | **65 ms** [53–115] to painted (15 samples) |
| Search < 150 ms | **60 ms** [25–121] to painted, not counting the 120 ms debounce (15 samples) |
| Optimistic bulk apply of 10k < 100 ms | **51 ms** [42–70] for 10,206 deals (New Lead → Lost); **56 ms** [47–76] to painted |
| Smooth scrolling | 3 s scrolling 37 rows per frame: median frame **16.7 ms**, p95 16.7, worst 33 ms; **42** rows in the DOM of 50,000 |
| Memory | **24.9 MB** [24.0–25.5] JS heap after GC with 50k deals loaded |

Caveats: one machine, one browser, headless, no GPU. The fake server runs on the same thread as the UI and there is
no real network. I did not test a low-end device, Firefox or Safari, or datasets above 200,000. `tests/perf.test.ts`
checks the same budgets in Node with 3× headroom for cold JIT; it is a regression guard, not a benchmark.

## Known limits, and what I'd do with more time

* **Verified:** Chromium only (Playwright, 1280/1440/1920 px wide, 800 px tall) and jsdom tests. The grid has ARIA
  roles, `aria-activedescendant` and live regions, and the tests assert those attributes, but **I did not test with
  a screen reader**. I did not test other browsers or screen sizes below 1280 px wide.
* **The client holds all deals** (25 MB at 50k). Beyond about 200k this needs server-side queries and windowed pages.
* **Polling, not push:** teammates' changes can be up to 2 s stale.
* **No auth, no real backend**, one signed-in user (Priya). The fake server is single-process, with no persistence.
* **A reload loses unsaved edits and the undo stack** (they live in memory; the browser warns first).
* **Bulk moves are last-write-wins:** a bulk patch has no per-deal base version, so it can overwrite a teammate's
  concurrent edit of the same field.
* **Editing is limited** to stage (keys, picker, buttons), value (detail panel) and creating deals. The engine
  supports owner and follow-up edits, but there is no UI for them. No notes, no deleting, no undo of a creation.
* **A created deal can't be moved or edited until the server confirms it.** If a create's response is lost and you
  Revert it, the server may still have it; it then arrives through the change feed.
* **Undo** doesn't check whether a teammate changed the deal since, and there is no redo.
* The Today ranking weights are my heuristics, not tuned with users.

With more time: server-side windowed queries and a push channel; merging per field and conflict handling for bulk
writes; persisting pending edits and undo (IndexedDB); owner and follow-up editing in the UI; a committed Playwright
suite (including two tabs) and perf budgets in CI; a real screen-reader and keyboard-only pass; narrower layouts.

## How I used AI tools

I worked with Claude Code (Anthropic's CLI agent) inside the repo, in rounds: I gave it a list of changes, it edited
the code, tests and docs, and had to run typecheck and tests before reporting back (and, for layout work, Playwright
screenshots and assertions at 1280, 1440 and 1920 px). I reviewed each round, and nothing was committed without my
review. It was most useful for the repetitive cross-cutting work: a stage change now goes through one function so keys,
the picker, the bulk bar, bulk jobs and the fake server's teammates all clear or restore the same fields.

What I did not take on trust, and what the checks caught: a selection that stayed selected after a partial move, and
Space confirming the stage picker also toggling a row (each was reproduced in a browser first, the fix was made at the
cause, and the regression tests were confirmed to fail without it); a clipped "+N" chip and truncated headers that
only showed up in screenshots; and a perf test that silently depended on the seed. Where a requested layout failed
its own checks, it was reported and the deviation documented instead of hidden. The Playwright scripts were throwaway
and are not in the repo.

<!-- TODO(author): confirm this section, and add how the first five commits were produced and any other tools used. -->

---

# Reference

## Dev Panel and scenarios

Open it with the **Dev** button (top right); it overlays the right edge. It sets latency (300–1500 ms by default),
the **Failure rate** slider (10% of write requests fail at random), the share of failures where the response is lost
(30%), per-deal bulk failure (0.4%), teammate changes per minute (12), polling interval (2 s), offline, and dataset
size and seed. It also shows live stats and the last performance measurements.

Scenarios apply to **"the next save"**: the first new write request (a deal save, a bulk chunk or a create) sent
after you arm one. They only affect that save. Other deals, older retries and reads (loading, the change feed) are
never affected and never use one up. Scenarios queue, so arming two affects the next two saves. An **Armed** box
shows what is waiting, or in progress, and clears when it is consumed. Below it, a **request log** lists the last 10
write requests, newest first: the deal, the attempt number (the same save counts 1, 2, 3 …) and the outcome (ok,
failed, response lost, conflict, or "ok (already applied)" for a replay that was not applied twice), marked
`scenario` or `random` when it was injected.

| Button | What happens to the next save | What to look for |
|---|---|---|
| **Fail next save (all retries)** | Every automatic attempt (the first send and the two retries) fails. A manual Retry works. | **Not saved**: the tray turns red ("1 not saved"), the Failed tab gets a badge and lists the deal, and Retry / Revert / Retry all work from there. The log shows 3 failed attempts |
| **Fail next attempt (retry recovers)** | One attempt fails; the automatic retry succeeds. | A quiet retry: "Retrying…", then saved. Never Not saved. Log: try 1 failed, try 2 ok |
| **Response lost on next save** | The server applies the write, then the response is lost. | One silent retry, saved once. Log: try 1 response lost, try 2 ok (already applied); "Writes applied on server" goes up by exactly one |
| **Teammate edits my pending deal** | The next save collides with a teammate edit **to the same field**. | A conflict with **Keep mine / Take theirs** in the detail panel and the tray; log: conflict |
| **…different field (silent rebase)** | Same, but the teammate edits a different field. | Nothing visible; "Silent rebases" goes up in the stats |
| **Burst of 10 teammate changes** | Ten changes arrive; half target rows in your list. | Rail counts move live; rows that would move wait behind the pill |
| **Go offline 10s** | Requests fail fast for 10 s. | Offline chip, persistent toast; unsaved changes retry when it returns; log: offline |

Note: a moved deal leaves a filtered list at once, so after a failure look at the tray or the **Failed** tab, not the
list you moved it from. The tray opens above the Dev Panel; the detail panel's Retry button is hidden behind the Dev
Panel while it is open.

## Keyboard

That is the whole map; nothing else is bound (no command palette, no number keys). It is listed at the bottom of the
left sidebar with a "Keys act on: Deals table | Stage list" line, and the active zone has a focus ring. The zone (rail
or table) and the focused row are app state, not whatever the browser happens to have focused. Letter keys do nothing
while you type in a text field (text, search, number, select, textarea) or while a dialog is open; checkboxes, buttons
and rows never count as typing.

| Key | Action |
|---|---|
| `↑` `↓` / `W` `S` | Move up / down (rows in the table, stages in the rail) |
| `←` `→` / `A` `D` | Switch zone: `A` to the stage rail, `D` back to the table |
| `Space` | Table: select / unselect the focused row. Rail: apply (or clear) the stage under the cursor |
| `Shift+↑` `↓` | Extend the selection (shrinks when you reverse) |
| `J` / `L` | Previous / next stage of the selection or focused row, in either zone. Won and Lost don't advance; `J` reopens them into Negotiation |
| `K` | Stage picker (`↑` `↓` then `Enter` or `Space`) |
| `N` | New deal |
| `Esc` | Close the sync tray, else clear the selection. In a text field: leave it and return to the table. If focus is stranded on a panel control (a slider, a Tab-focused button), hand the keyboard back to the table |
| `Ctrl/⌘ Z` | Undo the last move (it issues new writes; nothing is rolled back in place) |

Actions use the selection if there is one, otherwise the focused row. After any move the whole selection is cleared
and focus moves to the next row still listed.

**Mouse and keyboard mix.** Clicking a row sets the focused row and the table zone; clicking a rail stage sets the rail
zone and applies the filter. After any click (row, checkbox, button, panel, blank space) DOM focus returns to the
table, so keys keep working and a focused button or checkbox can't also react to Space. Text fields, sliders and
dialogs keep their own focus; closing a dialog, pressing Esc or Enter in the search box, or clicking the table hands it
back. On a Tab-focused button or checkbox, Space does the native click or toggle only. Mouse equivalents: the detail panel's stage buttons, **Move to…** in the
bulk bar, and a header checkbox to select all rows in the view (then **Select all N matching**).

## Layout and fields

* **Layout:** stage rail (with the key list at its foot) · table · detail panel. The detail panel follows the focused
  row; with several deals selected it shows the count, total value and a count per stage, with stage buttons.
* **Table:** never scrolls horizontally, rows are a fixed 40 px. Deal is capped at 30% of the width and ellipsizes;
  the other columns share the rest proportionally, each with a floor equal to its widest content. Owner is hidden in
  Today and My deals; Lic. and Close are hidden below 1400 px of table width (the detail panel shows them). Today has
  a **Why** column with up to two chips and "+N". **Sync** is blank unless a deal is saving, failed, in conflict or
  waiting on a teammate's change.
* **Next step** is a contact-by date for New Lead, a follow-up for open stages, and "—" for Won/Lost. **Close** is the
  expected date for open deals ("in 12d", or "3d overdue" in red) and the actual date for closed ones ("Closed 3d ago").
* **Closing and reopening:** moving to Won/Lost clears the next step in the same write, by every path; reopening with
  `J` sets a follow-up 3 days out and an expected close 30 days out. Undo restores the stage, next step and original
  close date. A deal moved to Won/Lost from Today stays in place ("Won today") until Refresh.

## Design notes

* **Two layers.** `server` is the last confirmed row per deal; `overlay` holds unconfirmed intents. A row is
  `overlay(server)` plus a status: synced, queued, saving, failed or conflict. The engine has no React imports.
* **Per-deal write list**, not a global queue, so one slow deal can't stall the rest. Edits coalesce only into a
  queued single write, never the in-flight one or across a bulk write. A retry reuses the idempotency key; a rebase
  gets a new one because it is a different request.
* **Teammates' data is applied immediately**, and deferral only governs the order and membership of the list. Counts
  and conflict detection need current data.
* **Counts are kept incrementally** from before/after diffs (mine, all), plus a scoped count for Today, Failed and
  search, checked against a full recount in tests. Each row subscribes to its own cached `RowView`, so one change
  re-renders one row (tested).
* **Bulk:** ids are frozen when the job starts; the optimistic overlay is applied in one batch; requests go out in
  chunks of ≤500, two at a time. A deal with an earlier unsent edit is parked behind it ("N waiting on earlier
  edits"). Cancel stops unsent chunks (in-flight ones finish). Moves of up to 25 deals are tracked per deal instead.
* **Loading** waits for every chunk before rendering, because streaming rows in would reorder a list the user may
  already be using.
* **Seed:** 20 users, about 5% of deals mine, about 20% in New Lead, a long tail of stuck deals; relative to "now" so
  Today always has content. About 12% of Won/Lost deals closed in the last week.
* **Dependencies:** `react`, `react-dom`, `@tanstack/react-virtual`. Dev: Vite, TypeScript, Vitest, jsdom,
  Testing Library. Playwright was used from outside the repo.

## Tests

`npm test` runs 142 tests in 7 files (Vitest, fake timers, seeded RNG): the sync engine (optimistic apply, two
retries, applied-but-lost does not double-apply, ordering and coalescing, silent rebase, same-field conflict,
creating deals, and each Dev scenario's exact end state); bulk jobs (partial failure, retry, cancel, undo); the store (snapshot vs teammates' changes,
deferral, pinned focus, scoped counts, closing and reopening, undo, the Failed view and tray); the selection model; `priority()`, chip order,
Today membership and the seed's shape; performance budgets; and jsdom UI tests for grid semantics, the keyboard,
typing safety, keys after every kind of mouse click, the stage picker, creating a deal, the Dev Panel's armed indicator, the failed-save flow, live regions and render counts. There is no committed browser (e2e)
suite.

## Deploy

GitHub Pages, via `.github/workflows/deploy.yml`. On every push to `main` (or a manual run) it runs `npm ci`,
typecheck and tests, builds with `VITE_BASE=/<repo-name>/`, and publishes `dist`. One-time setup: repository
**Settings → Pages → Source: GitHub Actions**. The Node version comes from `.nvmrc`. Local dev is unaffected (the base
is `/` unless `VITE_BASE` is set). To check the subpath build locally:

```bash
export VITE_BASE=/<repo-name>/
npm run build && npm run preview     # then open http://localhost:4173/<repo-name>/
```

I verified the subpath build this way (assets, scrolling, `?seed=` and `?size=`). The workflow itself has not been run
on GitHub yet.

## Folder map

```
src/
  domain/   types, stages, priority() and Today rules, selectors, patch and stage-move rules, new-deal rules
  api/      Api interface, FakeServer, seeded RNG and data, live settings
  sync/     engine (no React), overlay, bulk runner, undo stack, change feed
  state/    PipelineApp store (framework-free), view snapshot, selection model, React hooks
  keyboard/ the key handler and the key list shown in the sidebar
  ui/       React components
tests/      Vitest + Testing Library
```
