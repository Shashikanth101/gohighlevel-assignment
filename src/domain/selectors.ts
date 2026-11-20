import type { Deal, SortSpec, StageId, ViewFilter, ViewId } from './types'
import { ME } from './types'
import { isTerminal } from './stages'
import { priority } from './priority'

export interface MatchCtx {
  now: number
  /** Membership test for the Failed view (owned by the sync engine). */
  isFailed?: (id: string) => boolean
}

export const defaultSort = (view: ViewId): SortSpec =>
  view === 'today' ? { key: 'priority', dir: 'desc' } : { key: 'activity', dir: 'desc' }

export const EMPTY_FILTER: ViewFilter = { view: 'today', stage: null, query: '' }

export function matches(deal: Deal, f: ViewFilter, ctx: MatchCtx): boolean {
  switch (f.view) {
    case 'today':
      if (deal.ownerId !== ME || isTerminal(deal.stage) || priority(deal, ctx.now).reasons.length === 0) return false
      break
    case 'mine':
      if (deal.ownerId !== ME) return false
      break
    case 'failed':
      if (!ctx.isFailed?.(deal.id)) return false
      break
    case 'all':
      break
  }
  if (f.stage && deal.stage !== f.stage) return false
  if (f.query) {
    const q = f.query.toLowerCase()
    if (!deal.name.toLowerCase().includes(q) && !deal.id.toLowerCase().includes(q)) return false
  }
  return true
}

/**
 * Fields whose change can alter membership or order of the current view. A remote change
 * touching one of these is deferred behind the "N updates" pill instead of moving rows.
 */
export function viewFields(f: ViewFilter, sort: SortSpec): Set<string> {
  const s = new Set<string>()
  if (f.view === 'today') for (const k of ['ownerId', 'stage', 'nextFollowUpAt', 'stageEnteredAt', 'valueInr', 'expectedCloseAt']) s.add(k)
  if (f.view === 'mine') s.add('ownerId')
  if (f.stage) s.add('stage')
  if (f.query) s.add('name')
  switch (sort.key) {
    case 'priority':
      for (const k of ['nextFollowUpAt', 'stageEnteredAt', 'valueInr', 'expectedCloseAt', 'stage']) s.add(k)
      break
    case 'value': s.add('valueInr'); break
    case 'close': s.add('expectedCloseAt'); break
    case 'activity': s.add('lastActivityAt'); break
    case 'name': s.add('name'); break
  }
  return s
}

function sortKey(d: Deal, sort: SortSpec, now: number): number | string {
  switch (sort.key) {
    case 'priority': return priority(d, now).score
    case 'value': return d.valueInr
    case 'close': return d.expectedCloseAt
    case 'activity': return d.lastActivityAt
    case 'name': return d.name
  }
}

/** Build the ordered id list for a filter + sort. O(n) filter, O(m log m) sort. */
export function buildView(deals: Iterable<Deal>, f: ViewFilter, sort: SortSpec, ctx: MatchCtx): string[] {
  const rows: { id: string; k: number | string }[] = []
  for (const d of deals) if (matches(d, f, ctx)) rows.push({ id: d.id, k: sortKey(d, sort, ctx.now) })
  const dir = sort.dir === 'asc' ? 1 : -1
  rows.sort((a, b) => (a.k < b.k ? -dir : a.k > b.k ? dir : a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return rows.map((r) => r.id)
}

export interface StageTotals {
  count: number
  value: number
}
export type StageCounts = Record<StageId, StageTotals>
export const emptyCounts = (): StageCounts => ({
  new: { count: 0, value: 0 }, contacted: { count: 0, value: 0 }, demo: { count: 0, value: 0 },
  proposal: { count: 0, value: 0 }, negotiation: { count: 0, value: 0 }, won: { count: 0, value: 0 },
  lost: { count: 0, value: 0 },
})

export interface ScopedCounts {
  all: StageCounts
  mine: StageCounts
}
export const emptyScoped = (): ScopedCounts => ({ all: emptyCounts(), mine: emptyCounts() })

/** Incremental maintenance: remove `prev`'s contribution, add `next`'s. */
export function adjustCounts(c: ScopedCounts, prev: Deal | undefined, next: Deal | undefined): void {
  const bump = (d: Deal, sign: 1 | -1) => {
    const a = c.all[d.stage]
    a.count += sign
    a.value += sign * d.valueInr
    if (d.ownerId === ME) {
      const m = c.mine[d.stage]
      m.count += sign
      m.value += sign * d.valueInr
    }
  }
  if (prev) bump(prev, -1)
  if (next) bump(next, 1)
}
