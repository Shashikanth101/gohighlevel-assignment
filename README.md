# Sales Pipeline

A single-screen sales pipeline for a 20-person team sharing ~50,000 deals. Built for a take-home: a small
product that is honest about what it does when the network is slow, saves fail, and teammates change things.

`DESIGN.md` is the product source of truth. `DECISIONS.md` records every call I made (and what I rejected),
`WRITEUP.md` is the short narrative, `DEMO.md` is a 2–3 minute walkthrough script.

## Run it

```bash
npm install
npm run dev          # http://localhost:5173
npm test             # 67 tests, Vitest + Testing Library, fake timers, seeded RNG
npm run typecheck
npm run build
```

URL params: `?seed=42` and `?size=50000` (min 100). Everything is seeded, so the same seed and the same
sequence of actions replays the same data and the same failures.

There is no backend. A fake server lives inside the app (`src/api/fakeServer.ts`) behind an `Api` interface.
`window.app` is exposed in the console for poking around.

## What you are looking at

| Area | What it does |
|---|---|
| **Views** (header) | My Today (default), My deals, All deals, Failed. `G` then `T/M/A/F`. |
| **Today** | My open deals that have at least one reason to be worked, ranked. Every row shows why as chips: *Follow-up overdue 3d*, *Stuck in Proposal 14d*, *High value*, *Closes in 4d*. |
| **Stage rail** | Count and value per stage, live. Click to filter. Counts follow the view scope (my deals vs all deals). |
| **Grid** | Virtualized `role="grid"`, fixed 40px rows, ~46 rows in the DOM no matter how many deals. |
| **Sync tray** (top right) | `All saved` / `Saving 3` / `2 not saved`. Turns red and stays red while anything is unresolved. Retry all, Discard all, per-item actions. |
| **Updates pill** | "N updates from teammates · Show" appears when a teammate change would move or remove rows. Nothing moves until you click it (or press `U`). |
| **Bulk bar / Jobs panel** | Select many rows, move them in one go. Jobs dock at the bottom with progress, Cancel, Retry failed, Undo. |
| **Dev Panel** (`Shift+D` or the Dev button) | Latency, failure rate, teammate rate, offline, dataset size and seed, scenario buttons, live stats and the last performance measurements. |

## Dev Panel scenarios

| Button | What happens | What to look for |
|---|---|---|
| **Fail next save** | The next request fails (random kind: rejected or applied-but-response-lost). | "Retrying…", then it succeeds quietly on retry. |
| **Next save: applied, response lost** | The server applies the write, then the response is lost. | One silent retry; the server shows exactly one application (Dev Panel stats). No double apply. |
| **Fail next 3 requests** | Exhausts the two auto-retries. | Row shows **Not saved** with Retry / Revert, the tray goes red, an assertive live message fires. The change is kept on screen. |
| **Teammate edits my pending deal** | Armed: the next deal you save collides with a teammate edit **to the same field**. | A conflict: "Arjun moved this to Lost" with **Keep mine / Take theirs**, in the row, the tray and the detail panel. |
| **…different field (silent rebase)** | Armed: the teammate edit is to a different field. | Nothing visible, except "Silent rebases" ticking up in stats. Your save lands on top of theirs. |
| **Burst of 10 teammate changes** | Ten teammate changes arrive; half of them target rows in your current list (so the pill reliably appears). | Rail counts move live; rows that are in your list and would move wait behind the pill. |
| **Go offline 10s** | All requests fail fast for 10 s. | Offline chip, persistent toast; unsaved changes retry automatically on reconnect. |

Failure rate, latency (300–1500 ms default), the lost-response share, the per-deal bulk failure rate
(0.4 % default) and the teammate rate are all live sliders.

## Keyboard

Everything is also in the command palette (`Ctrl/⌘ K`) and the in-app help (`?`).
Single-key shortcuts are off while you type in a field, and while a dialog is open.

| Key | Action |
|---|---|
| `J` `K` / `↓` `↑` | Next / previous row. `Home` `End` `PgUp` `PgDn` jump. |
| `Space` | Select / unselect the focused row |
| `Shift+↓/↑` | Extend the selection (shrinks when you reverse) |
| `Ctrl/⌘ A` | Select every row in the view, then a banner offers **Select all N matching** |
| `M` | Stage picker (arrows + Enter, or a number) |
| `1`–`7` | Move the focused deal (or the whole selection) to that stage |
| `Enter` | Open details · `Esc` closes details / tray / clears selection |
| `/` | Search · `Esc` leaves the field and returns to the grid |
| `G` then `T` `M` `A` `F` | Jump to My Today / My deals / All deals / Failed |
| `Z` (or `Ctrl/⌘ Z`) | Undo the last move (issues new writes; nothing is rolled back in place) |
| `R` / `Shift+R` | Retry the focused unsaved deal / retry all |
| `D` | Revert the focused unsaved deal |
| `U` | Show teammate updates |
| `S` | Cycle sort |
| `Ctrl/⌘ K` | Command palette (every action) |
| `?` | Shortcuts help |

Grid semantics: `role="grid"`, one tab stop, `aria-activedescendant` points at the focused row, `aria-rowcount`
reflects all rows (not just the rendered window), visible focus ring, no hover-only controls. Focus is
never lost when a row leaves the list: DOM focus stays on the grid and the active row advances.

## How it works (short version)

```
src/
  domain/   types, stages (config-driven), priority() (pure), selectors, patch helpers
  api/      Api interface, FakeServer, seeded RNG + data, live settings
  sync/     engine (NO React), overlay, bulk runner, undo stack, change feed
  state/    PipelineApp store (framework-free), view snapshot, selection model, React hooks
  ui/       components      keyboard/  one keymap feeding keys, palette and help
```

* **Two layers.** `server` is the last confirmed row per deal. `overlay` holds unconfirmed intents. A row is
  `overlay(server)` plus a status: synced, queued, saving, failed, conflict.
* **Per deal:** one request in flight, later edits queue behind it and coalesce, order is never changed. A failed
  or conflicted head write blocks that deal's queue until you resolve it.
* **Failures:** two auto-retries (400 ms, 1200 ms) with the same idempotency key, then **Not saved**. The server
  stores results by key, so "applied but the response was lost" cannot double-apply on retry.
* **Conflicts:** every write carries a base version and the pre-edit values of the fields it touches. On a
  version mismatch, if the teammate's current values for *those fields* equal the pre-edit values, we rebase
  silently and resend. Otherwise the row shows both sides.
* **The view is a snapshot** (an array of ids). It is rebuilt only on filter, sort, search, Refresh, or
  "Show updates". My own edit can remove a row that no longer matches (focus moves to the next row); incoming
  teammate data never does.
* **Row-level subscriptions.** Each row selects its own `RowView` from the store; the `RowView` object is cached
  and replaced only when that deal changes, so one change re-renders one row (tested).
* **Bulk:** ids are materialised and frozen when the job starts. The optimistic overlay is applied in one batched
  update; requests go out in chunks of ≤500, two at a time.

## Performance

Targets from the brief, measured. Numbers are from this machine (WSL2), 50,000 deals, seed 42.
Browser = headless Chromium driven by Playwright with **software rendering** (no GPU), so paint numbers are
pessimistic. Node = `tests/perf.test.ts` (cold JIT, no paint). All timings are logged with `performance.measure`
(`pipeline:*`) and shown live in the Dev Panel.

| Target | Measured | Where |
|---|---|---|
| First interactive render after data < 1 s | **~70 ms** after the last chunk (data itself takes ~1.7 s: 10 simulated 5k-deal chunks with latency) | browser |
| Filter / sort change < 150 ms at 50k | view build **10–55 ms**; filter→painted **77–107 ms**, sort→painted **~108 ms**, search→painted **49–107 ms** | Node / browser |
| Optimistic bulk apply of 10k < 100 ms | **~59 ms** for 9,926 deals (**~76 ms** to painted). Node cold: 85–105 ms | browser / Node |
| Scrolling stays smooth | Torture test (37 rows per frame): median frame **16.7 ms**, p95 50 ms, max 100 ms; **46** rows in the DOM | browser |
| Memory | **~34 MB** JS heap with 50k deals loaded | browser |

Honest caveats: this is one machine, one run per figure, headless and GPU-less. The Node bulk-apply number sits
right at the target when cold, which is why the test allows 3× headroom. I did not profile on a low-end device.

## Tests

`npm test` runs 67 tests: engine (optimistic apply and confirm, two retries then failed, manual retry,
applied-but-lost does not double-apply, same-deal ordering and coalescing, silent rebase, same-field conflict with
both resolutions), bulk (partial failure, retry failed, chunk-level retry, cancel, undo, ordering behind a single
edit), store (remote change leaves the snapshot alone, deferral and "Show updates", pinned focus, moved-out rows,
Failed view, undo, Lost confirmation), selection model, `priority()` reasons and ordering, seed shape, and jsdom UI
tests for grid semantics, keyboard, typing safety, live regions and render counts.

The browser flows (keyboard move, forced failure, conflict, bulk with failures, retry, undo, scroll) were driven
with a throwaway Playwright script that is **not** part of the repo; there is no committed e2e suite.

## Known limits (deliberately not hidden)

* **The client holds all 50k deals** (~34 MB). Past roughly 500k this needs server-side queries and windowed pages.
* **Polling, not push**: the change feed is polled every 2 s (adjustable). Teammate changes can be up to that stale.
* **No auth, no real backend**, one user ("me" = Priya, user 0). The fake server is single-process and has no persistence.
* **Reload loses everything unsaved.** `beforeunload` warns, but pending edits and the undo stack are in memory only.
* **Bulk writes are last-write-wins.** Single edits use optimistic concurrency; a bulk patch carries no per-deal
  base version, so a bulk move can overwrite a teammate's concurrent edit to the same field.
* **Editable fields are stage, owner and value** (owner has no UI yet; the engine supports it). No notes, no
  creating or deleting deals, no real follow-up scheduling.
* **No drag-and-drop, no board.** Cut on purpose (see DECISIONS.md).
* **Undo of an undo is not supported**, and Undo does not guard against a teammate having changed the deal since.
* **The "Select all matching" banner rarely differs from "select all in view"** in this single-client demo; it
  exists so the selection model (filter + exclusions) is real and tested, and it diverges when teammates add rows.
