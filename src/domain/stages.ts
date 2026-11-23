import type { StageId } from './types'

export interface StageConfig {
  id: StageId
  label: string
  /** Days in stage before a deal counts as "stuck". null for terminal stages. */
  dwellDays: number | null
  terminal: boolean
}

export const STAGES: readonly StageConfig[] = [
  { id: 'new', label: 'New Lead', dwellDays: 3, terminal: false },
  { id: 'contacted', label: 'Contacted', dwellDays: 5, terminal: false },
  { id: 'demo', label: 'Demo Done', dwellDays: 7, terminal: false },
  { id: 'proposal', label: 'Proposal Sent', dwellDays: 10, terminal: false },
  { id: 'negotiation', label: 'Negotiation', dwellDays: 14, terminal: false },
  { id: 'won', label: 'Won', dwellDays: null, terminal: true },
  { id: 'lost', label: 'Lost', dwellDays: null, terminal: true },
]

const byId = new Map(STAGES.map((s) => [s.id, s]))
export const stageConfig = (id: StageId): StageConfig => byId.get(id)!
export const stageLabel = (id: StageId): string => byId.get(id)!.label
export const isTerminal = (id: StageId): boolean => byId.get(id)!.terminal
export const stageIndex = (id: StageId): number => STAGES.findIndex((s) => s.id === id)

/**
 * The stage one step along the pipeline, or null when there is nowhere sensible to go.
 * Open stages run New Lead -> ... -> Negotiation -> Won. Won/Lost are endings: they never advance
 * (so one key press can't turn a win into a loss) but "previous" reopens them into Negotiation.
 */
export function adjacentStage(id: StageId, dir: 1 | -1): StageId | null {
  const i = stageIndex(id)
  if (isTerminal(id)) return dir === -1 ? 'negotiation' : null
  const j = i + dir
  return j < 0 ? null : STAGES[j]!.id
}
