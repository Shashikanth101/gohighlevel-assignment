import type { Deal, DealPatch, PatchField } from '../domain/types'
import { PATCH_FIELDS } from '../domain/types'
import { applyPatch } from '../domain/patch'

/** One unit of user intent for a single deal. */
export interface Write {
  /** Idempotency key. Re-used for retries of the same request, renewed when the request changes (rebase). */
  key: string
  patch: DealPatch
  /** Values of the patched fields BEFORE the user's edit. Used to tell real conflicts from harmless version bumps. */
  base: DealPatch
  /** Server version this write was made against. */
  baseVersion: number
  at: number
  source: 'single' | 'bulk'
  jobId?: string
}

export type EntryStatus = 'queued' | 'saving' | 'failed' | 'conflict'

/**
 * Unconfirmed intents for one deal. `inflight` is the write currently on the wire (at most one);
 * `writes` are queued behind it, strictly in order. The user sees `inflight` then `writes` folded onto the server row.
 */
export interface OverlayEntry {
  id: string
  inflight: Write | null
  writes: Write[]
  status: EntryStatus
  /** Failed attempts of the current in-flight write. */
  attempts: number
  retrying: boolean
  error?: string
  /** Teammate's current row when status === 'conflict'. */
  theirs?: Deal
  timer?: ReturnType<typeof setTimeout>
  /** Identifies the current network attempt so late responses from abandoned attempts are ignored. */
  token: number
}

export function allWrites(e: OverlayEntry): Write[] {
  return e.inflight ? [e.inflight, ...e.writes] : e.writes
}

/** Server row with every unconfirmed write applied in order. */
export function foldEntry(server: Deal, e: OverlayEntry): Deal {
  let d = server
  if (e.inflight) d = applyPatch(d, e.inflight.patch, e.inflight.at)
  for (const w of e.writes) d = applyPatch(d, w.patch, w.at)
  return d
}

/** Merged patch the user currently sees (later writes win). */
export function visiblePatch(e: OverlayEntry): DealPatch {
  return Object.assign({}, ...allWrites(e).map((w) => w.patch)) as DealPatch
}

/** Merged pre-edit values: the earliest write to touch a field defines its base. */
export function visibleBase(e: OverlayEntry): DealPatch {
  const out: Partial<Record<PatchField, unknown>> = {}
  for (const w of allWrites(e)) for (const f of PATCH_FIELDS) if (w.base[f] !== undefined && !(f in out)) out[f] = w.base[f]
  return out as DealPatch
}
