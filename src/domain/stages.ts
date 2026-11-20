import type { StageId } from './types'

export interface StageConfig {
  id: StageId
  label: string
  /** Key 1-7 sets this stage. */
  key: string
  /** Days in stage before a deal counts as "stuck". null for terminal stages. */
  dwellDays: number | null
  terminal: boolean
}

export const STAGES: readonly StageConfig[] = [
  { id: 'new', label: 'New Lead', key: '1', dwellDays: 3, terminal: false },
  { id: 'contacted', label: 'Contacted', key: '2', dwellDays: 5, terminal: false },
  { id: 'demo', label: 'Demo Done', key: '3', dwellDays: 7, terminal: false },
  { id: 'proposal', label: 'Proposal Sent', key: '4', dwellDays: 10, terminal: false },
  { id: 'negotiation', label: 'Negotiation', key: '5', dwellDays: 14, terminal: false },
  { id: 'won', label: 'Won', key: '6', dwellDays: null, terminal: true },
  { id: 'lost', label: 'Lost', key: '7', dwellDays: null, terminal: true },
]

const byId = new Map(STAGES.map((s) => [s.id, s]))
export const stageConfig = (id: StageId): StageConfig => byId.get(id)!
export const stageLabel = (id: StageId): string => byId.get(id)!.label
export const isTerminal = (id: StageId): boolean => byId.get(id)!.terminal
export const stageIndex = (id: StageId): number => STAGES.findIndex((s) => s.id === id)
