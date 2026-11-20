# Sales Pipeline: write-up

## What I built and why

One screen where a 20-person team works a shared 50,000-deal pipeline without losing work, losing their place, or
reaching for the mouse. It opens on **My Today**: my open deals that have a reason to be worked, ranked, with the
reason on every row ("Follow-up overdue 3d", "Stuck in Proposal 14d"). The design brief came from five complaints;
each one maps to a mechanism:

| Complaint | Mechanism |
|---|---|
| "I don't know what to work on" | A ranked Today queue from a pure, unit-tested `priority()` |
| "I moved a deal, it didn't save, nobody told me" | Optimistic overlay, per-deal status, quiet auto-retry, persistent failure state, tray, undo |
| "Deals keep jumping around" | The list is a snapshot; teammate changes patch data in place and defer anything that would move a row |
| "I need to move thousands to Lost" | Select-all-matching, then a chunked, cancellable, retryable, undoable job |
| "I can't use a mouse for long" | Every action has a key, a palette entry and proper grid semantics |

A small product that is honest beats a big one that isn't, so I spent the time on the sync engine and its failure
behaviour rather than on screens.

## UX decisions, and what I rejected

* **Table, not a Kanban board.** A 10,000-card column can't be scanned, drag-and-drop is mouse-only, and bulk moves
  across columns are awkward. A virtualized table with a stage rail does all three jobs. I also cut drag-to-rail.
* **Never roll back silently.** A failed move keeps showing what you asked for, marked **Not saved**, with Retry and
  Revert. Rejected: a modal per failure (interrupts), toast-only (vanishes, which is the original complaint),
  blocking spinners, silent revert.
* **A moved deal leaves the list if it no longer matches the filter** and focus advances to the next row. It is still
  tracked in the tray and the Failed view, so a failure can't hide behind the triage flow.
* **A priority queue you can explain.** Rejected: an opaque score. The chips *are* the explanation.
* **Confirm only where it hurts.** Moves to Lost above 50 deals ask once, with exact counts by stage and the total
  value. Everything else is undoable instead of confirmed.

## Failed saves

Each deal has one request in flight; later edits queue behind it and coalesce. A save that fails at the transport
level is retried twice (400 ms, then 1.2 s) with the *same idempotency key*, then marked **Not saved**.

The fake server fails in two ways because they behave differently: **rejected before applying** (~70 %) and
**applied, but the response was lost** (~30 %). The second is the dangerous one: a naive retry applies the change
twice. The server stores results by idempotency key, so a retry replays the stored result; there is a test that
asserts exactly one application. A failed head write blocks later writes to that deal, so they can't overtake it.

Failure is announced three ways: a persistent red tray and Failed-tab badge, a persistent toast with a Retry action,
and an `aria-live="assertive"` message. `beforeunload` warns while anything is pending.

## Teammate changes

The list is an array of ids rebuilt only when *I* act (filter, sort, search, Refresh, "Show updates"). A teammate
change that doesn't affect the current filter or sort patches in place with a brief highlight. One that would move
or remove a row waits behind **"N updates from teammates · Show"**; the focused row and the selection stay pinned
across it. Stage-rail counts update live because they move nothing.

When a teammate edits a deal I have a pending save for, the server answers with a version conflict. Each write
carries the *pre-edit values* of the fields it touches: if the teammate changed other fields, I rebase silently and
resend; if they changed the same field, I show "Arjun moved this to Lost" with **Keep mine / Take theirs**.

## What I'd do next

* Server-side windowed queries instead of holding 50k rows in the client; a push channel instead of polling.
* Per-field merging beyond "same field vs not", and conflict handling for bulk writes (today they are last-write-wins).
* Persist the overlay and undo stack (IndexedDB) so a reload doesn't lose unsaved work.
* Owner and follow-up editing in the UI; drag onto the rail; a read-only board view.
* A committed Playwright suite across two tabs, and perf budgets enforced in CI.

## Honest limits

The client holds all 50k deals (~34 MB). Changes arrive by polling every 2 s. There is no auth and no real backend.
Pending edits and undo live in memory and are lost on reload (the browser warns first). Bulk writes can overwrite a
teammate's concurrent edit. Performance numbers come from one machine, headless Chromium without a GPU, and one run
per figure (see README); the browser flows were verified with a throwaway script that is not in the repo. Select-all
semantics are subtle in a single-client demo (see DECISIONS.md #29).
