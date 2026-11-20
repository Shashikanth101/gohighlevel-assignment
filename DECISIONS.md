# Decisions

Format: **decision** — why — *rejected alternative*. Calls I made without asking, in roughly the order they came up.

## Disagreements with DESIGN.md / the brief (and what I did)

1. **Drag onto the stage rail: cut.** DESIGN.md calls the rail a drop target. It is the first thing the brief says to
   cut when behind, it is mouse-only (the opposite of the goal), and the keyboard path (`1`–`7`, `M`) covers the same
   job. The rail filters; it does not accept drops.
2. **Notes: not implemented.** DESIGN.md mentions notes as an in-place teammate edit. There is no notes field; value
   and owner edits cover "fields that don't affect sort or filter".
3. **The updates pill also counts rows entering my view.** The brief defers changes "for rows in the view". A
   teammate moving a deal *into* my filter is just as relevant to "stay current", so those are counted in the pill
   (but never inserted until I ask). Everything else follows the brief.
4. **`queue.ts` does not exist.** The per-deal queue (in-flight + ordered writes) and the engine's state machine
   cannot be separated without passing half the engine around, so both live in `sync/engine.ts` with the data
   shapes in `sync/overlay.ts`. *Rejected: a separate queue module that the engine reaches into.*

## Architecture

5. **Hand-rolled store, no Zustand.** One framework-free `PipelineApp` class plus `useSyncExternalStore` with a
   selector hook. It is ~100 lines of glue, keeps `sync/` and `state/` testable in plain Node, and avoids a
   dependency I would have to justify. *Rejected: Zustand (fine, but one more dependency for no gain here).*
6. **Row-level subscriptions via cached `RowView` objects + selectors, not per-id listener maps.** One global
   emitter; each row selects `app.getRow(id)`, whose result is cached and invalidated per id. React bails out for
   every row whose snapshot is unchanged. At ~46 mounted rows the selector calls are trivial, and it is one
   mechanism instead of two. *Rejected: a `Map<id, Set<listener>>` (more code, same result).*
7. **The engine emits one batched event per transaction** (`touched`, `changes`, `remote`, `acked`, …). The store
   derives counts, view changes and announcements from it. *Rejected: the engine calling into the store.*
8. **Counts are maintained incrementally** from effective-row diffs (`adjustCounts(prev, next)`), for two scopes
   (mine, all). Tests compare against a full recount. *Rejected: recomputing on every change.*
9. **Stage-rail counts are scoped to my deals or all deals, not to the Today view.** Today is a derived queue;
   showing "stuck in Contacted" counts there would look like pipeline totals and invite misreading.

## Sync engine

10. **Per-deal write list, not a global mutation queue.** `inflight` + `writes[]`, strictly ordered, one request in
    flight per deal; concurrency across deals is unlimited for single edits. *Rejected: a single global queue
    (head-of-line blocking: one slow deal would stall everyone).*
11. **Coalescing only merges into a queued single write**, never the in-flight one (it is already on the wire) and
    never across a bulk write (that would reorder). The oldest `base` per field is kept.
12. **A failed or conflicted head write blocks that deal's later writes.** Sending later writes past a failed one
    would apply them out of order. The user's latest intent stays visible and is sent together when they Retry.
    *Rejected: letting later writes overtake.*
13. **No silent rollback, ever.** Failed rows keep showing the intended value with **Not saved**. Revert is an
    explicit action. *Rejected: reverting on failure (it is the original complaint).*
14. **Auto-retry reuses the idempotency key; a rebase gets a new one.** A retry is the same request; a rebased
    write is a different request (new base version), so it must not be deduplicated against the old one.
15. **Conflict resolution by comparing pre-edit values (`base`) with the teammate's current values** for exactly the
    fields I touched. Equal → silent rebase; different → surface both. A third case: if the server *already has my
    values* (my own write landed, or a teammate made the same change) it is treated as success, not a conflict.
    *Rejected: any version mismatch is a conflict (prompts constantly); always last-write-wins (loses work).*
16. **Remote changes are applied to `server` immediately; "deferral" only governs view membership and order.**
    The row shows current data and, if it would move, a small "Arjun edited · moves on refresh" marker. Keeping data
    current is required for conflict detection and live rail counts. *Rejected: holding remote data in a side buffer
    until "Show" (counts go stale, conflicts get detected against the wrong base).*
17. **My own writes echo back through the feed and are ignored for deferral** (`updatedBy === me`). Otherwise every
    save would produce an "update from teammates" pill.
18. **Bulk is last-write-wins (no per-deal base version).** A bulk patch is "set stage = Lost"; handling up to 500
    per-deal conflicts per chunk would need a resolution UI I can't justify in 6 hours. Listed as a known limit.
    *Rejected: per-id versions in bulk requests.*
19. **A bulk write for a deal that already has an in-flight or queued write is parked** behind it (order preserved)
    and resumes automatically. The job shows "N waiting on earlier edits".
20. **Retry on one failed bulk row goes through the single-deal path** (new key, current server version). Tray
    "Retry all" groups bulk-failed rows back through their job, so 300 failed rows are not 300 requests.
21. **Cancel stops unsent chunks and reverts their optimistic rows; in-flight chunks finish** (they can't be
    recalled). Undo (job) = discard the failed rows + one new job per distinct inverse patch for the confirmed
    rows. Undo is only offered once the job has stopped.
22. **Reconnect auto-retries failures whose cause was "offline"** (safe: nothing reached the server). Other
    failures wait for the user. Offline does not freeze the queue; it just fails fast and surfaces.
23. **Polling every 2 s**, adjustable. Overlapping polls are skipped. *Rejected: a fake push channel (more code, and
    would hide the staleness limit the write-up should be honest about).*

## Product / UX

24. **Table, not board** (per DESIGN.md). A 10k-card column can't be scanned, drag is mouse-only, bulk moves are
    awkward.
25. **A move that no longer matches the filter removes the row immediately; focus goes to the next row** (or the
    previous one at the end). It stays tracked in the tray, the Failed view and, for bulk, the job. This means
    moving a deal out of **Today** by changing its stage can also drop it (its dwell clock restarts), which is what
    triage should do. *Rejected: keeping gone rows as ghosts.*
26. **Moves that still match stay in place with a status marker** (Saving… → ✓ Saved for ~1.8 s → nothing).
27. **Multi-select moves of ≤25 deals are tracked per deal** (own status, own failure, one undo item); larger moves
    become a bulk job. Below 25 the Jobs panel would be noise; above it, per-deal requests would be a stampede.
28. **Moves to Lost above 50 deals require confirmation with exact counts** (by current stage, plus total value).
    The ids are frozen when the dialog opens, so what you confirmed is what runs.
29. **`Ctrl/⌘ A` selects the view snapshot as an explicit id set; the banner converts it to "filter + exclusions".**
    In a single-client demo the two are usually the same size, so I made the banner always explain which one you
    have. The selection is **cleared on any view/filter/search change** (Gmail-style) so a bulk action never applies
    to rows the user can no longer see.
30. **Failures are never toast-only.** Persistent tray state (red), a persistent toast with an action, a Failed
    badge on the tab, and an `aria-live="assertive"` message. Everything else is `polite`.
31. **Toasts sit bottom-left inside the main area** (above the grid, never over the toolbar or the Jobs dock):
    top-center covered the updates pill and a fixed bottom-left collided with the Jobs panel.
32. **Search is debounced (120 ms)** and `Enter` applies it immediately. Selection is cleared on search (see 29).
33. **Esc inside an input blurs it and returns to the grid**, so the keyboard never gets stranded.

## Domain

34. **`priority()`** — overdue follow-up 40 + days (cap 30); stuck beyond the stage threshold 25 + days over (cap 30);
    high value (≥ ₹15 L) 15 + up to 10; closing within 7 days 30 − days. Won/Lost never score. Per-stage dwell
    thresholds (3/5/7/10/14 days) live in `stages.ts`. A close date *in the past* is not a reason (the brief says
    "within 7 days"); an overdue follow-up already covers that urgency.
35. **A stage change restarts the dwell clock optimistically** (`stageEnteredAt = now`), matching the server, so the
    "Stuck in…" chip disappears immediately instead of lying until the ack.
36. **Seed:** 20 users, 5 % mine (~2,500), "New Lead" ≈ 20 % (~10k), exponential recency, a long dwell tail,
    follow-ups from 12 days overdue to 14 ahead, log-normal values. Relative to "now", so Today always has content.

## Performance

37. **Initial load waits for all chunks before rendering.** Streaming rows in as chunks arrive would mean building
    and then re-ordering the view while the user may already be interacting, which is exactly the jumping the design
    forbids. The loading screen shows progress instead.
38. **`view-build` is one O(n) filter plus an O(m log m) sort over precomputed keys.** No indexes. At 50k it is
    10–55 ms, so indexes would be complexity without a payoff.
39. **Fixed row height (40 px), `@tanstack/react-virtual`, overscan 12.** Row position is `index × 40`, so `DealRow`
    is memoised on `(id, index)` alone.

## Dependencies

Runtime: `react`, `react-dom`, `@tanstack/react-virtual` (required by the brief). Dev: Vite, TypeScript, Vitest,
jsdom, Testing Library. **Nothing else.** Playwright was used for manual browser checks from outside the repo.
