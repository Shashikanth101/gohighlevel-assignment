# Sales Pipeline: Design

**Goal.** One screen where a 20-person team can work a shared 50,000-deal pipeline without losing work, losing their place, or reaching for the mouse.

## What the users said, and what we do

| They said | We do |
|---|---|
| "I don't know which deals to work on today" | Default view is **My deals · Today**: a ranked queue where every row shows why it is there ("Follow-up overdue 3d", "Stuck in Proposal 14d") |
| "I moved a deal, it didn't save, nobody told me" | Optimistic UI with per-deal sync state, quiet auto-retry, persistent failure markers, a Sync tray, and undo |
| "Deals keep jumping around" | The view order is a snapshot. Teammate changes patch data in place and defer anything that would move or remove a row |
| "I need to move thousands to Lost" | "Select all N matching", then a chunked, cancellable, retryable, undoable bulk job |
| "I can't use a mouse for long" | Every action has a key, plus a command palette and proper grid semantics |

## The view: virtualized table, not a board

Layout: stage rail (count and value per stage; it filters, and is also a drop target) · virtualized grid · detail panel.

A 10,000-card Kanban column cannot be scanned, drag-and-drop is mouse-only, and bulk moves across columns are awkward. **Rejected:** a board (possible read-only stretch), a table with no default opinion, and an opaque priority score. Today ranking is a pure, unit-tested function of overdue follow-up, dwell time past a per-stage threshold, value, and expected close date.

## Data and sync model

- The client holds lean records for all 50k (about 7-10 MB), loaded in chunks. **Limit:** past roughly 500k deals this becomes server-side query with windowed pages.
- Two layers: `server` (last confirmed, versioned) and `overlay` (unconfirmed user intents). A row shows `overlay(server)` plus a status: synced, saving, failed, or conflict.
- One request in flight per deal, with queued edits coalesced. Every request carries a base `version` and an idempotency key.
- The view order is an array of ids rebuilt only on user action (sort, filter, refresh, "apply updates"), never by incoming data. Rows subscribe individually, so one change re-renders one row.

## Failed saves

- The user's intent stays visible. We never silently roll back.
- Two quiet auto-retries with backoff, then the row is marked **Not saved** with Retry / Revert.
- The simulated failure has two modes: rejected before applying, and applied but the response was lost. Idempotency keys make retries safe in both.
- If a moved row no longer matches the current filter it leaves the list (triage flow, cursor advances). It is tracked in the **Sync tray** (Saving 3, Failed 2, Retry all / Discard) and a Failed view. The tray never auto-dismisses while anything is unresolved.
- Failures are announced via `aria-live`, and `beforeunload` warns while changes are pending.
- **Rejected:** a modal per failure, toast-only (it vanishes, which is the original complaint), blocking spinners, and silent rollback.

## Teammate changes

- Changes to fields that do not affect sort or filter (value, owner, notes) apply in place with a brief highlight.
- Changes that would move or remove a row are deferred behind an "N updates, Show" pill. Stage-rail counts update live because they move nothing.
- The focused row, the selection, and any open edit are pinned.
- Version mismatch on save: if the fields the user changed are untouched by the teammate, rebase silently. Otherwise show "Priya moved this to Lost" with Keep mine / Take theirs.

## Bulk

- Selection is an id set, or a filter plus an exclusion set. Ids are materialized only when the job starts, and that target set is frozen.
- Jobs run in chunks of about 500 with limited concurrency. The panel shows done and failed counts, with Cancel, Retry failed, and Undo.
- The optimistic overlay is applied as one batched operation. Moves to Lost above a threshold need a confirm showing exact counts.

## Keyboard

`J/K` or arrows move, `Space` selects, `Shift+arrows` extends a range, `Ctrl/Cmd+A` selects the view (then "select all N matching"), `M` opens the stage picker, `1-7` sets the stage, `Enter` opens details, `/` searches, `G` then a letter jumps to a view, `Cmd/Ctrl+K` opens the command palette, `Z` undoes, `?` shows help, `Esc` clears. Focus is never lost when a row leaves the list.

## Fake API and test controls

An in-app server behind an `Api` interface holds authoritative versioned data. A dev panel adjusts latency range (default 300-1500 ms), failure rate (default 10%), teammate change rate, offline, dataset size, and seed. Scenario buttons trigger deterministic cases: fail next save, teammate edits my pending deal, burst of 10 changes, go offline 10 s.

## With more time

Server-side windowed queries, real-time transport instead of polling, per-field CRDT-style merging, saved views, a read-only board, drag onto the rail, e2e tests across tabs, and measured perf budgets in CI.