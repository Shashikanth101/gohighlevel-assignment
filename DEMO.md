# Demo script (about 3 minutes)

Setup: `npm run dev`, open the app, press `Shift+D` to open the Dev Panel. Defaults are fine (latency 300–1500 ms,
10 % failure). Seed 42 gives the same data every time.

## 1. Today view (0:00–0:30)
* The app opens on **My Today**: ~1,200 of my 2,475 deals, ranked. Point at the chips: *Follow-up overdue 10d*,
  *Stuck in Contacted 6d*, *High value*, *Closes in 2d*. "Every row says why it's here."
* Rail counts on the left. Press `G` `A` for All deals (50,000), then `G` `T` back. Note it is instant.

## 2. Keyboard move (0:30–1:00)
* `J` `J` to move down; `5` moves the focused deal to Negotiation. Row shows **Saving…** then **✓ Saved**; the
  Undo toast appears. Press `Z`: it goes back (a new write, not a rollback).
* Press `M`, then `7`: the deal goes to Lost, leaves Today, and focus advances to the next row without a click.

## 3. Forced failure and retry (1:00–1:45)
* Dev Panel → **Fail next 3 requests**. Press `4` on a deal.
* Watch **Retrying…** (two quiet retries), then **Not saved** with Retry / Revert. The tray turns red
  ("1 not saved"), the Failed tab gets a badge, the value on screen is still what you chose.
* Open the tray, show the item, press **Retry** (or `R` on the row). It saves.
* Optional: **Next save: applied, response lost**, make a move, then show "Writes applied on server" went up by
  exactly one. No double apply.

## 4. Teammate change (1:45–2:15)
* Dev Panel → **Burst of 10 teammate changes**, or lower the poll interval. Rail counts tick live. If a change
  touches a row in view, the **"N updates from teammates · Show"** pill appears and nothing moves.
* Press `U` (or click Show): the list updates, the focused row stays put.
* For a conflict: **Teammate edits my pending deal**, then move any deal. The tray shows "Dev moved this to Lost"
  with **Keep mine / Take theirs**.

## 5. 8k bulk to Lost, a failure, then undo (2:15–3:00)
* `G` `A`, click **Contacted** in the rail (~7,900 deals).
* `Ctrl+A`, click **Select all N matching**, press `7`. The confirmation shows exact counts and value. Confirm.
* The Jobs panel fills in chunks of 500, two at a time. A few deals fail (0.4 % per-deal failure rate): the job
  ends "Finished with N not saved", the tray shows them.
* Click **Retry failed** → all done. Then `Z` (or **Undo** on the job): a new job restores each deal's previous stage.
* Close by pointing at the Dev Panel's performance list: optimistic apply of ~10k rows in well under 100 ms.
