import type { Deal, DealPatch, PatchField, StageId } from './types'
import { PATCH_FIELDS } from './types'
import { DAY } from './priority'
import { isTerminal } from './stages'

/** Apply a patch to a deal (pure). A stage change restarts the dwell clock, unless the patch carries its own `stageEnteredAt` (undo). */
export function applyPatch(deal: Deal, patch: DealPatch, at: number): Deal {
  const next: Deal = { ...deal, ...patch }
  if (patch.stage !== undefined && patch.stage !== deal.stage && patch.stageEnteredAt === undefined) next.stageEnteredAt = at
  return next
}

export function patchFields(patch: DealPatch): PatchField[] {
  const out: PatchField[] = []
  for (const f of PATCH_FIELDS) if (patch[f] !== undefined) out.push(f)
  return out
}

/** The current values of exactly the fields `patch` touches (the inverse patch). */
export function pickFields(deal: Deal, patch: DealPatch): DealPatch {
  const out: Record<string, unknown> = {}
  for (const f of PATCH_FIELDS) if (patch[f] !== undefined) out[f] = deal[f]
  // A stage change also moves the entry/close date, so undoing it must put that back too.
  if (patch.stage !== undefined) out.stageEnteredAt = deal.stageEnteredAt
  return out as DealPatch
}

/** True when applying `patch` to `deal` changes nothing. */
export function isNoop(deal: Deal, patch: DealPatch): boolean {
  for (const f of PATCH_FIELDS) if (patch[f] !== undefined && deal[f] !== patch[f]) return false
  return true
}

export function samePatch(a: DealPatch, b: DealPatch): boolean {
  const fa = patchFields(a)
  return fa.length === patchFields(b).length && fa.every((f) => a[f] === b[f])
}

/** Which fields differ between two versions of a deal. */
export function changedFields(a: Deal, b: Deal): PatchField[] {
  return PATCH_FIELDS.filter((f) => a[f] !== b[f])
}

// ---- stage moves ----------------------------------------------------------------------

export const REOPEN_FOLLOW_UP_DAYS = 3
export const REOPEN_CLOSE_DAYS = 30

/**
 * What else a stage change must carry. Closed deals have no next step; reopening one gives it something to act on.
 * Every path (key, picker, bulk bar, detail panel, bulk jobs) builds its patch here, so the inverse (undo) restores it all.
 */
export type MoveKind = 'plain' | 'close' | 'reopen'
export function moveKind(from: StageId, to: StageId): MoveKind {
  if (isTerminal(to)) return isTerminal(from) ? 'plain' : 'close'
  return isTerminal(from) ? 'reopen' : 'plain'
}
export function movePatch(kind: MoveKind, to: StageId, now: number): DealPatch {
  switch (kind) {
    case 'close': return { stage: to, nextFollowUpAt: null }
    case 'reopen': return { stage: to, nextFollowUpAt: now + REOPEN_FOLLOW_UP_DAYS * DAY, expectedCloseAt: now + REOPEN_CLOSE_DAYS * DAY }
    default: return { stage: to }
  }
}
export const stageMovePatch = (deal: Deal, to: StageId, now: number): DealPatch => movePatch(moveKind(deal.stage, to), to, now)
