import type { NewDealInput } from '../domain/newDeal'
import type { Deal, DealPatch } from '../domain/types'

/** Backoff before each automatic retry of a failed write. So a write is sent at most 1 + length times before it is "Not saved". */
export const AUTO_RETRY_DELAYS_MS = [400, 1200]
export const AUTO_ATTEMPTS = 1 + AUTO_RETRY_DELAYS_MS.length

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

export interface CreateRequest {
  input: NewDealInput
  /** Re-sent unchanged on retry, so "created but response lost" cannot create the deal twice. */
  idempotencyKey: string
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
  /** The server assigns the real id. */
  createDeal(req: CreateRequest): Promise<Deal>
}
