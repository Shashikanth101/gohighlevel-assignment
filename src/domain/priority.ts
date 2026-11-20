import type { Deal } from './types'
import { isTerminal, stageConfig, stageLabel } from './stages'

export const DAY = 86_400_000
export const HIGH_VALUE_INR = 1_500_000

export type ReasonKind = 'overdue' | 'stuck' | 'value' | 'closing'
export interface Reason {
  kind: ReasonKind
  label: string
}
export interface Priority {
  score: number
  reasons: Reason[]
}

const NONE: Priority = { score: 0, reasons: [] }

/**
 * Pure ranking of an open deal. Reasons: overdue follow-up, dwell beyond the stage
 * threshold, high value, close date within 7 days. Won/Lost deals never qualify.
 */
export function priority(deal: Deal, now: number): Priority {
  if (isTerminal(deal.stage)) return NONE
  const reasons: Reason[] = []
  let score = 0

  if (deal.nextFollowUpAt !== null && deal.nextFollowUpAt < now) {
    const days = Math.floor((now - deal.nextFollowUpAt) / DAY)
    reasons.push({ kind: 'overdue', label: days < 1 ? 'Follow-up overdue today' : `Follow-up overdue ${days}d` })
    score += 40 + Math.min(days, 30)
  }

  const threshold = stageConfig(deal.stage).dwellDays
  if (threshold !== null) {
    const dwell = Math.floor((now - deal.stageEnteredAt) / DAY)
    if (dwell > threshold) {
      reasons.push({ kind: 'stuck', label: `Stuck in ${stageLabel(deal.stage)} ${dwell}d` })
      score += 25 + Math.min(dwell - threshold, 30)
    }
  }

  if (deal.valueInr >= HIGH_VALUE_INR) {
    reasons.push({ kind: 'value', label: 'High value' })
    score += 15 + Math.min(10, Math.floor(deal.valueInr / HIGH_VALUE_INR))
  }

  const untilClose = deal.expectedCloseAt - now
  if (untilClose >= 0 && untilClose <= 7 * DAY) {
    const days = Math.ceil(untilClose / DAY)
    reasons.push({ kind: 'closing', label: days <= 0 ? 'Closes today' : `Closes in ${days}d` })
    score += 30 - days
  }

  return reasons.length ? { score, reasons } : NONE
}
