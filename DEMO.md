# Demo script (about 3 minutes)

Setup: `npm run dev`, open the app, click **Dev** to open the Dev Panel. Defaults are fine (latency 300–1500 ms,
10 % failure). Seed 42 gives the same data every time.

## 1. Today view (0:00–0:30)
* The app opens on **Today**: 1,299 of my 2,423 deals (1,217 open items, then 82 closed in the last week), ranked. Point at the chips: *Follow-up overdue 10d*,
  *Stuck in Contacted 6d*, *High value*, *Closes in 2d*. "Every row says why it's here."
* Rail counts on the left. Click All deals (50,000), then Today back. Note it is instant. Click **Contacted** in the rail: it filters Today ("Today · Contacted · N", × to clear) and the rail counts are Today's. Click **Won**: it stays in Today and lists what I closed this week (*Won 2d ago*, *Lost 5d ago*). Move an open deal to Won (`K`): the row stays put with *Won today* until Refresh; its Next step becomes "—" and Close reads "Closed today". Press `Ctrl/⌘ Z` and the follow-up date comes back. `J` on a Won deal reopens it into Negotiation with a follow-up in 3 days.

## 2. Keyboard move (0:30–1:00)
* `S` `S` to move down; `L` moves the focused deal one stage along. Row shows **Saving…**; the Undo toast appears.
  Press `Ctrl/⌘ Z`: it goes back (a new write, not a rollback).
* Press `K`, pick Lost with the arrows and `Enter`: the deal leaves Today, and focus advances to the next row.
* `A` jumps to the stage rail (the focus ring moves), `D` back to the table. `N` adds a deal.

## 3. Forced failure and retry (1:00–1:45)
* Dev Panel → **Fail next save (all retries)** (an "Armed" box appears). Press `L` on a deal.
* The request log shows three failed attempts, then the deal is **Not saved**. The tray turns red
  ("1 not saved"), the Failed tab gets a badge and lists the deal, the value on screen is still what you chose.
  (For a quiet retry instead, arm **Fail next attempt (retry recovers)**: try 1 fails, try 2 is ok.)
* Open the tray, show the item, press **Retry**. It saves.
* Optional: **Response lost on next save**, make a move: the log shows "response lost" then "ok (already applied)",
  and "Writes applied on server" went up by exactly one. No double apply.

## 4. Teammate change (1:45–2:15)
* Dev Panel → **Burst of 10 teammate changes** (half target rows in your list). Rail counts tick live; value
  edits flash in place; stage moves that would reorder or remove rows raise the **"N updates from teammates · Show"**
  pill, and nothing moves.
* Click Show: the list updates, the focused row stays put.
* For a conflict: **Teammate edits my pending deal**, then move any deal. The tray shows "Dev moved this to Lost"
  with **Keep mine / Take theirs**.

## 5. 8k bulk to Lost, a failure, then undo (2:15–3:00)
* Click All deals, then **Contacted** in the rail (~7,900 deals).
* Tick the header checkbox (select all in view), click **Select all N matching** in the bulk bar, then **Lost**. The confirmation shows exact counts and value. Confirm.
* The Jobs panel fills in chunks of 500, two at a time. A few deals fail (0.4 % per-deal failure rate): the job
  ends "Finished with N not saved", the tray shows them.
* Click **Retry failed** → all done. Then `Ctrl/⌘ Z` (or **Undo** on the job): a new job restores each deal's previous stage.
* Close by pointing at the Dev Panel's performance list: optimistic apply of ~10k rows in well under 100 ms.
