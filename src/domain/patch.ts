import type { Deal, DealPatch, PatchField } from './types'
import { PATCH_FIELDS } from './types'

/** Apply a patch to a deal (pure). A stage change restarts the dwell clock. */
export function applyPatch(deal: Deal, patch: DealPatch, at: number): Deal {
  const next: Deal = { ...deal, ...patch }
  if (patch.stage !== undefined && patch.stage !== deal.stage) next.stageEnteredAt = at
  return next
}

export function patchFields(patch: DealPatch): PatchField[] {
  return PATCH_FIELDS.filter((f) => patch[f] !== undefined)
}

/** The current values of exactly the fields `patch` touches (the inverse patch). */
export function pickFields(deal: Deal, patch: DealPatch): DealPatch {
  const out: Record<string, unknown> = {}
  for (const f of patchFields(patch)) out[f] = deal[f]
  return out as DealPatch
}

/** True when applying `patch` to `deal` changes nothing. */
export function isNoop(deal: Deal, patch: DealPatch): boolean {
  return patchFields(patch).every((f) => deal[f] === patch[f])
}

export function samePatch(a: DealPatch, b: DealPatch): boolean {
  const fa = patchFields(a)
  return fa.length === patchFields(b).length && fa.every((f) => a[f] === b[f])
}

/** Which fields differ between two versions of a deal. */
export function changedFields(a: Deal, b: Deal): PatchField[] {
  return PATCH_FIELDS.filter((f) => a[f] !== b[f])
}
