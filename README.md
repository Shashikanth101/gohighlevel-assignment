# Sales Pipeline

A one-screen sales pipeline for a 20-person team sharing about 50,000 deals, built around what happens when saves fail, the network is slow, and teammates change things under you.

* **Video walkthrough:** [https://youtu.be/SgyuJjSM8as](https://youtu.be/SgyuJjSM8as)
* **Live demo:** [https://shashikanth101.github.io/gohighlevel-assignment/](https://shashikanth101.github.io/gohighlevel-assignment/)

```bash
npm install && npm run dev      # http://localhost:5173
```

There is no backend. A fake server inside the app holds the data and simulates delays, failed saves and teammates' edits. Everything is seeded, so the same seed and actions replay the same data and failures. `npm test` runs 142 tests.

## Try it in a minute

1. Open the app. It starts on **Today**: your open deals ranked by what needs attention, with the reason on every row.
2. Use the keyboard: `↑↓` or `W S` to move, `Space` to select, `L` / `J` for next / previous stage, `K` to pick any stage.
3. Click **Dev** (top right), arm **Fail next save (all retries)**, close the panel and move a deal. Watch it turn **Not saved**, then fix it from the red sync tray or the **Failed** tab.
4. In **Dev**, arm **Burst of 10 teammate changes**. Rows don't move. A pill says "N updates from teammates · Show".
5. Go to **My deals**, pick a stage, tick the header checkbox, choose **Select all N matching**, press `K` and move them all to Lost. Cancel, retry failures or undo from the job panel.

## What I built and why

Each complaint in the brief became one design decision:

| Complaint | What the app does |
|---|---|
| "I don't know which deals to work on" | A ranked **Today** list from a pure, unit-tested `priority()`. Every row says why it's there (overdue, stuck, high value, closing soon). |
| "I moved a deal, it didn't save, nobody told me" | Optimistic moves with a status per deal, quiet retries, and a failure state that stays until you resolve it. |
| "Deals keep jumping around" | The list is a snapshot. Teammates' changes never reorder or remove a row until you ask. |
| "I need to move thousands to Lost" | Select all matching, then a chunked job you can cancel, retry and undo. |
| "I can't use a mouse for long" | A small, fixed keyboard map. Every action also has a visible control. |

I spent most of the time on the sync engine and its failure behaviour, and less on screens.

## Key UX decisions, and what I rejected

| Decision | Why | Rejected |
|---|---|---|
| A virtualized table, not a board | A 10,000-card column can't be scanned, and drag needs a mouse | Kanban board |
| Reasons shown as chips, in a fixed order | The ranking is explainable and checkable | An opaque score |
| A failed save keeps your value, marked **Not saved**, with Retry / Revert | A silent revert is the original complaint | A modal per failure, toast-only, silent rollback |
| The list is a snapshot of ids, rebuilt only when *I* act | Rows under the cursor must not move | Live-sorting as data arrives |
| A stage filter keeps you in the current view (also Today) | The count you click is the number of rows you get | Jumping to another view |
| Confirm only large moves to Lost; everything else is undoable | Dialogs everywhere get ignored | Confirming every move |

## Failed saves

Each deal has one request in flight, and later edits queue behind it. A failure is retried twice (400 ms, then 1.2 s) with the same idempotency key. After that the row is marked **Not saved**, keeps the value you chose, and offers Retry / Revert. It is shown four ways: the sync tray stays red, the Failed tab gets a badge, a persistent toast offers Retry, and a live-region message is announced. The browser warns before you leave with unsaved changes.

The fake server fails in two ways: rejected before applying, and **applied but the response lost**. The second is the dangerous one, since a naive retry would apply the change twice. The server replays results by idempotency key, and a test asserts exactly one application.

## Teammates' changes

The app polls the change feed every 2 s.
* A change that doesn't affect the current filter or sort patches the row in place with a brief highlight.
* A change that would move or remove a row waits behind **"N updates · Show"**. The focused row and your selection stay pinned.
* If a teammate edits a deal you have a pending save for, the app rebases silently when they touched a different field. If they touched the same field, you choose **Keep mine / Take theirs**.

## Performance

Measured on a production build with 50,000 deals (Core i5 laptop, Chromium via Playwright, software rendering, so pessimistic). Medians:

| What | Result |
|---|---|
| Filter change | 29 ms to painted |
| Sort change | 65 ms to painted |
| Optimistic bulk move of about 10,000 deals | 51 ms |
| Scrolling | 16.7 ms median frame, 42 rows in the DOM of 50,000 |
| Memory | about 25 MB heap with all deals loaded |

One machine, one browser, no low-end device. Method and caveats are in the [details](docs/DETAILS.md).

## Known limits, and what I'd do next

* **The client holds all deals.** That's fine at 50k, but past about 200k it needs server-side queries and windowed pages.
* **Polling, not push**, so teammates' changes can be up to 2 s stale.
* **Bulk moves are last-write-wins** and can overwrite a teammate's concurrent edit of the same field.
* **A reload loses unsaved edits and undo.** The browser warns first.
* **Tested in Chromium only.** The grid has ARIA roles and live regions, but I did not test with a screen reader or other browsers.
* **Editing is limited** to stage, value and creating deals.

With more time: server-side windowed queries and a push channel, per-field merging for bulk writes, persisted pending edits (IndexedDB), a committed end-to-end test suite and perf budgets in CI, and a real screen-reader pass.

## How I used AI tools

I worked with Claude Code inside the repo, in rounds. I gave it a list of changes, and it edited code, tests and docs and had to run typecheck and tests before reporting back. I reviewed every round, and nothing was committed without my review. The decisions above are mine. Where I did not take its work on trust, I reproduced bugs in a browser first, such as Space confirming the stage picker and also toggling a row. Fixes were then made at the cause, with regression tests.

## More detail

The Dev Panel scenarios, the full keyboard map, layout rules, design notes, test coverage, deploy setup and folder map are in [docs/DETAILS.md](docs/DETAILS.md).