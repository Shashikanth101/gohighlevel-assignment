import type { Deal, DealPatch } from '../domain/types'

export type NetworkErrorKind = 'offline' | 'rejected' | 'lost'

/** Thrown when a request fails at the transport level. The caller cannot know if it applied. */
export class NetworkError extends Error {
  readonly kind: NetworkErrorKind
  constructor(kind: NetworkErrorKind, message?: string) {
    super(message ?? (kind === 'offline' ? 'You are offline' : kind === 'lost' ? 'Connection lost' : 'Server unavailable'))
    this.name = 'NetworkError'
    this.kind = kind
  }
}

export interface UpdateRequest {
  id: string
  patch: DealPatch
  baseVersion: number
  idempotencyKey: string
}
export type UpdateResult = { ok: true; deal: Deal } | { ok: false; conflict: true; current: Deal }

export interface BulkRequest {
  /** At most 500. */
  ids: string[]
  patch: DealPatch
  idempotencyKey: string
}
export interface BulkItemResult {
  id: string
  ok: boolean
  deal?: Deal
  error?: string
}

export interface RemoteChange {
  seq: number
  deal: Deal
}
export interface ChangesResult {
  changes: RemoteChange[]
  seq: number
}

export const MAX_BULK = 500

export interface Api {
  /** Streams chunks (~5,000 deals); resolves with the feed sequence the snapshot is current to. */
  listDeals(onChunk: (deals: Deal[], loaded: number, total: number) => void): Promise<number>
  changesSince(seq: number): Promise<ChangesResult>
  updateDeal(req: UpdateRequest): Promise<UpdateResult>
  bulkUpdate(req: BulkRequest): Promise<BulkItemResult[]>
}
