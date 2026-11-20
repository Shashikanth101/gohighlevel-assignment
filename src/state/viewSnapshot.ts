/**
 * The view is a SNAPSHOT: an ordered array of ids that only changes when the user acts
 * (filter, sort, search, refresh, "Show updates") or when the user's own edit makes a row stop matching.
 * Incoming teammate data never reorders or removes rows.
 */
import type { Deal, SortSpec, ViewFilter } from '../domain/types'
import type { MatchCtx } from '../domain/selectors'
import { buildView } from '../domain/selectors'

export interface ViewSnapshot {
  ids: readonly string[]
  filter: ViewFilter
  sort: SortSpec
  /** Clock used for priority reasons, frozen with the snapshot so labels don't flicker. */
  now: number
  version: number
  set?: Set<string>
}

export function createSnapshot(deals: Iterable<Deal>, filter: ViewFilter, sort: SortSpec, ctx: MatchCtx, version: number): ViewSnapshot {
  return { ids: buildView(deals, filter, sort, ctx), filter, sort, now: ctx.now, version }
}

export function snapshotHas(s: ViewSnapshot, id: string): boolean {
  return (s.set ??= new Set(s.ids)).has(id)
}

/** Drop rows from the snapshot (a user edit moved them out). Order of the rest is untouched. */
export function removeIds(s: ViewSnapshot, removed: ReadonlySet<string>): ViewSnapshot {
  if (removed.size === 0) return s
  return { ...s, ids: s.ids.filter((id) => !removed.has(id)), set: undefined }
}

/**
 * Where focus goes after the list changed under it. Keeps the focused id if it survived; otherwise the
 * next surviving row after it (or the last row if it was at the end).
 */
export function pinFocus(oldIds: readonly string[], oldActive: string | null, newIds: readonly string[]): string | null {
  if (newIds.length === 0) return null
  if (oldActive === null) return newIds[0]!
  const keep = new Set(newIds)
  if (keep.has(oldActive)) return oldActive
  const at = oldIds.indexOf(oldActive)
  if (at < 0) return newIds[0]!
  for (let i = at + 1; i < oldIds.length; i++) if (keep.has(oldIds[i]!)) return oldIds[i]!
  for (let i = at - 1; i >= 0; i--) if (keep.has(oldIds[i]!)) return oldIds[i]!
  return newIds[0]!
}
