export type StageId = 'new' | 'contacted' | 'demo' | 'proposal' | 'negotiation' | 'won' | 'lost'

export interface Deal {
  id: string
  name: string
  licences: number
  valueInr: number
  ownerId: number
  stage: StageId
  /** Server version; bumped on every applied write. */
  version: number
  lastActivityAt: number
  stageEnteredAt: number
  nextFollowUpAt: number | null
  expectedCloseAt: number
  updatedAt: number
  updatedBy: number
}

/** Fields a user (or teammate) can edit. */
/** `stageEnteredAt` is normally derived from a stage change; it is patchable so undo can restore the original close/entry date. */
export const PATCH_FIELDS = ['stage', 'ownerId', 'valueInr', 'nextFollowUpAt', 'expectedCloseAt', 'stageEnteredAt'] as const
export type PatchField = (typeof PATCH_FIELDS)[number]
export type DealPatch = Partial<Pick<Deal, PatchField>>

export type SyncStatus = 'synced' | 'queued' | 'saving' | 'failed' | 'conflict'

export type ViewId = 'today' | 'mine' | 'all' | 'failed'

export interface ViewFilter {
  view: ViewId
  stage: StageId | null
  query: string
}

export type SortKey = 'priority' | 'value' | 'close' | 'activity' | 'name'
export interface SortSpec {
  key: SortKey
  dir: 'asc' | 'desc'
}

export const ME = 0
