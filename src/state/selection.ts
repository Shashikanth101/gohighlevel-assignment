/**
 * Selection model. Either an explicit id set, or "everything matching this filter, minus exclusions".
 * The second form is what makes "Select all 12,431 matching" cheap and correct: ids are only
 * materialised when a job actually starts (see `materialize`).
 */
import type { Deal, ViewFilter } from '../domain/types'
import type { MatchCtx } from '../domain/selectors'
import { matches } from '../domain/selectors'

export type Selection =
  | { kind: 'ids'; ids: ReadonlySet<string> }
  | { kind: 'filter'; filter: ViewFilter; excluded: ReadonlySet<string> }

export const EMPTY_SELECTION: Selection = { kind: 'ids', ids: new Set() }

export function isSelected(sel: Selection, id: string): boolean {
  // In filter mode every visible row matches the filter by construction, so only exclusions matter.
  return sel.kind === 'ids' ? sel.ids.has(id) : !sel.excluded.has(id)
}

/** `matchingTotal` is the live number of deals matching the selection's filter. */
export function selectionCount(sel: Selection, matchingTotal: number): number {
  return sel.kind === 'ids' ? sel.ids.size : Math.max(0, matchingTotal - sel.excluded.size)
}

export function isEmpty(sel: Selection, matchingTotal = 0): boolean {
  return selectionCount(sel, matchingTotal) === 0
}

export function toggle(sel: Selection, id: string): Selection {
  if (sel.kind === 'ids') {
    const ids = new Set(sel.ids)
    if (!ids.delete(id)) ids.add(id)
    return { kind: 'ids', ids }
  }
  const excluded = new Set(sel.excluded)
  if (!excluded.delete(id)) excluded.add(id)
  return { kind: 'filter', filter: sel.filter, excluded }
}

export function setSelected(sel: Selection, id: string, on: boolean): Selection {
  return isSelected(sel, id) === on ? sel : toggle(sel, id)
}

const idxOf = (ids: readonly string[], id: string) => ids.indexOf(id)

/** Select (or deselect) the inclusive range between two ids of the current view. */
export function selectRange(sel: Selection, viewIds: readonly string[], a: string, b: string, on = true): Selection {
  const i = idxOf(viewIds, a)
  const j = idxOf(viewIds, b)
  if (i < 0 || j < 0) return sel
  const [lo, hi] = i < j ? [i, j] : [j, i]
  if (sel.kind === 'ids') {
    const ids = new Set(sel.ids)
    for (let k = lo; k <= hi; k++) on ? ids.add(viewIds[k]!) : ids.delete(viewIds[k]!)
    return { kind: 'ids', ids }
  }
  const excluded = new Set(sel.excluded)
  for (let k = lo; k <= hi; k++) on ? excluded.delete(viewIds[k]!) : excluded.add(viewIds[k]!)
  return { kind: 'filter', filter: sel.filter, excluded }
}

/**
 * Shift+arrow: the cursor moved `from` -> `to` with `anchor` fixed. Moving away from the anchor selects
 * the row we land on; moving back toward it deselects the row we left. The anchor is always selected.
 */
export function extendSelection(sel: Selection, viewIds: readonly string[], anchor: string, from: string, to: string): Selection {
  const ia = idxOf(viewIds, anchor)
  const ifrom = idxOf(viewIds, from)
  const ito = idxOf(viewIds, to)
  if (ia < 0 || ifrom < 0 || ito < 0 || ifrom === ito) return sel
  let next = setSelected(sel, anchor, true)
  next = Math.abs(ito - ia) > Math.abs(ifrom - ia) ? setSelected(next, to, true) : setSelected(next, from, false)
  return next
}

export const selectAllInView = (viewIds: readonly string[]): Selection => ({ kind: 'ids', ids: new Set(viewIds) })
export const selectAllMatching = (filter: ViewFilter): Selection => ({ kind: 'filter', filter, excluded: new Set() })

/** Freeze the selection into concrete ids, in the order of `deals`. Called when a job starts. */
export function materialize(sel: Selection, deals: Iterable<Deal>, ctx: MatchCtx): string[] {
  if (sel.kind === 'ids') {
    const out: string[] = []
    // Keep selected ids only; order follows the data so results are deterministic.
    for (const d of deals) if (sel.ids.has(d.id)) out.push(d.id)
    return out
  }
  const out: string[] = []
  for (const d of deals) if (!sel.excluded.has(d.id) && matches(d, sel.filter, ctx)) out.push(d.id)
  return out
}
