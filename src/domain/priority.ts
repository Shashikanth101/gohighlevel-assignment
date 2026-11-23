import type { Deal } from './types'
import { isTerminal, stageConfig, stageLabel } from './stages'

export const DAY = 86_400_000
export const HIGH_VALUE_INR = 1_500_000
/** Won/Lost deals closed this recently still show in Today (after the open action items). */
export const RECENTLY_CLOSED_DAYS = 7

export type ReasonKind = 'overdue' | 'stuck' | 'value' | 'closing' | 'won' | 'lost'
export interface Reason {
  kind: ReasonKind
  label: string
  /** Compact form for table cells; `label` is the full text (tooltips, detail panel). */
  short: string
}

/** Fixed display order, most important first. Used by the table and the detail panel alike. */
export const CHIP_ORDER: readonly ReasonKind[] = ['value', 'overdue', 'closing', 'stuck']
export interface Priority {
  score: number
  reasons: Reason[]
}

const NONE: Priority = { score: 0, reasons: [] }

export const isRecentlyClosed = (deal: Deal, now: number): boolean =>
  isTerminal(deal.stage) && now - deal.stageEnteredAt <= RECENTLY_CLOSED_DAYS * DAY

/** "Won 2d ago" / "Lost 5d ago" / "Won today" for a recently closed deal, else null. */
export function closedChip(deal: Deal, now: number): Reason | null {
  if (!isRecentlyClosed(deal, now)) return null
  const word = deal.stage === 'won' ? 'Won' : 'Lost'
  const days = Math.floor((now - deal.stageEnteredAt) / DAY)
  const label = days < 1 ? `${word} today` : `${word} ${days}d ago`
  return { kind: deal.stage === 'won' ? 'won' : 'lost', label, short: label }
}

/** The chips a row carries: priority reasons for open deals, the closed chip for recently closed ones. */
export function whyChips(deal: Deal, now: number): Reason[] {
  const c = closedChip(deal, now)
  return c ? [c] : priority(deal, now).reasons
}

/** Today = my open deals with a reason to work them, plus my deals closed within RECENTLY_CLOSED_DAYS. */
export const inToday = (deal: Deal, now: number): boolean => isRecentlyClosed(deal, now) || whyChips(deal, now).length > 0

/**
 * Sort key for the Today (priority) order, descending: open items by score (always >= 15), then recently closed
 * deals newest first. A closed deal's key is a fraction below 1 that grows with stageEnteredAt.
 */
export const todaySortKey = (deal: Deal, now: number): number =>
  isTerminal(deal.stage) ? deal.stageEnteredAt / 1e14 : priority(deal, now).score
/**
 * Pure ranking of an open deal. Reasons: overdue follow-up, dwell beyond the stage
 * threshold, high value, close date within 7 days. Won/Lost deals never have priority reasons
 * (recently closed ones get a closed chip instead, see `whyChips`).
 */
export function priority(deal: Deal, now: number): Priority {
  if (isTerminal(deal.stage)) return NONE
  const reasons: Reason[] = []
  let score = 0

  if (deal.nextFollowUpAt !== null && deal.nextFollowUpAt < now) {
    const days = Math.floor((now - deal.nextFollowUpAt) / DAY)
    const what = deal.stage === 'new' ? 'Contact' : 'Follow-up'
    reasons.push({ kind: 'overdue', label: days < 1 ? `${what} overdue today` : `${what} overdue ${days}d`, short: days < 1 ? 'Overdue today' : `Overdue ${days}d` })
    score += 40 + Math.min(days, 30)
  }

  const threshold = stageConfig(deal.stage).dwellDays
  if (threshold !== null) {
    const dwell = Math.floor((now - deal.stageEnteredAt) / DAY)
    if (dwell > threshold) {
      reasons.push({ kind: 'stuck', label: `Stuck in ${stageLabel(deal.stage)} ${dwell}d`, short: `Stuck ${dwell}d` })
      score += 25 + Math.min(dwell - threshold, 30)
    }
  }

  if (deal.valueInr >= HIGH_VALUE_INR) {
    reasons.push({ kind: 'value', label: 'High value', short: 'High value' })
    score += 15 + Math.min(10, Math.floor(deal.valueInr / HIGH_VALUE_INR))
  }

  const untilClose = deal.expectedCloseAt - now
  if (untilClose >= 0 && untilClose <= 7 * DAY) {
    const days = Math.ceil(untilClose / DAY)
    reasons.push({ kind: 'closing', label: days <= 0 ? 'Closes today' : `Closes in ${days}d`, short: days <= 0 ? 'Closes today' : `Closes ${days}d` })
    score += 30 - days
  }

  reasons.sort((a, b) => CHIP_ORDER.indexOf(a.kind) - CHIP_ORDER.indexOf(b.kind))
  return reasons.length ? { score, reasons } : NONE
}
