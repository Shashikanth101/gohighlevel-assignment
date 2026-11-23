import { DAY } from '../domain/priority'
import { isTerminal } from '../domain/stages'
import type { Deal } from '../domain/types'

export function inr(v: number): string {
  if (v >= 1e7) return `₹${(v / 1e7).toFixed(2)} Cr`
  if (v >= 1e5) return `₹${(v / 1e5).toFixed(1)} L`
  return `₹${v.toLocaleString('en-IN')}`
}
export const num = (n: number): string => n.toLocaleString('en-IN')

/** "in 3d" / "2d ago" / "today". */
export function rel(ts: number | null, now: number): string {
  if (ts === null) return '—'
  const d = Math.round((ts - now) / DAY)
  return d === 0 ? 'today' : d > 0 ? `in ${d}d` : `${-d}d ago`
}

/** When a Won/Lost deal closed, in the past tense: "today" / "3d ago". Never a future value. */
export function closedAgo(deal: Deal, now: number): string {
  const d = Math.max(0, Math.floor((now - deal.stageEnteredAt) / DAY))
  return d === 0 ? 'today' : `${d}d ago`
}

export interface CloseCell {
  text: string
  tone: 'muted' | 'overdue' | 'normal'
}
/**
 * The Close column. Closed deals show the ACTUAL close date ("Closed 3d ago"); open deals the expected one, where a
 * date in the past reads "3d overdue" (an "ago" would be ambiguous next to the closed rows).
 */
export function closeCell(deal: Deal, now: number): CloseCell {
  if (isTerminal(deal.stage)) return { text: `Closed ${closedAgo(deal, now)}`, tone: 'muted' }
  const d = Math.round((deal.expectedCloseAt - now) / DAY)
  if (d < 0) return { text: `${-d}d overdue`, tone: 'overdue' }
  return { text: d === 0 ? 'today' : `in ${d}d`, tone: 'normal' }
}
