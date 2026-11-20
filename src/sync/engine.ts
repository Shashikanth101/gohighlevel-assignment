/**
 * Sync engine. NO React imports: the UI store subscribes to it.
 *
 * Invariants
 *  - `server` holds the last confirmed row per deal; `overlay` holds unconfirmed intents.
 *  - Per deal: one request in flight, later edits queue behind it (and coalesce), order is never changed.
 *  - A failed/conflicted head write blocks that deal's queue until the user resolves it.
 *  - Retries re-use the idempotency key, so "applied but response lost" cannot double-apply.
 */
import type { Api, RemoteChange } from '../api/api'
import { NetworkError } from '../api/api'
import type { Deal, DealPatch } from '../domain/types'
import { changedFields, isNoop, patchFields, pickFields } from '../domain/patch'
import type { EntryStatus, OverlayEntry, Write } from './overlay'
import { allWrites, foldEntry, visibleBase, visiblePatch } from './overlay'

export const RETRY_DELAYS_MS = [400, 1200]

export interface EffectiveChange {
  id: string
  prev: Deal | undefined
  next: Deal
}
export interface RemoteApplied {
  id: string
  prev: Deal | undefined
  next: Deal
  fields: string[]
  by: number
  /** Whether the user has unconfirmed edits on this deal. */
  pending: boolean
}
export interface JobSignal {
  jobId: string
  id: string
  state: 'done' | 'failed' | 'dropped'
}
export interface EngineEvent {
  /** Ids whose row (data or status) must re-render. */
  touched: string[]
  /** Subset of touched whose effective data changed (for incremental counts). */
  changes: EffectiveChange[]
  remote: RemoteApplied[]
  acked: string[]
  newFailures: { id: string; error: string }[]
  newConflicts: string[]
  jobSignals: JobSignal[]
  rebased: string[]
}

export interface Summary {
  queued: number
  saving: number
  failed: number
  conflict: number
  /** Entries with any unconfirmed write. */
  pending: number
}

export interface RowSync {
  status: EntryStatus
  error?: string
  retrying: boolean
  theirs?: Deal
  attempts: number
}

export interface EngineDeps {
  api: Api
  now?: () => number
  retryDelays?: number[]
}

type Listener = (e: EngineEvent) => void
const emptyEvent = (): EngineEvent => ({
  touched: [], changes: [], remote: [], acked: [], newFailures: [], newConflicts: [], jobSignals: [], rebased: [],
})

export class SyncEngine {
  readonly server = new Map<string, Deal>()
  readonly overlay = new Map<string, OverlayEntry>()
  /** Ids whose head write is failed/conflict (drives the Failed view). */
  readonly problems = new Set<string>()
  /** Set by the bulk runner so it learns when a parked deal becomes sendable. */
  onBulkReady?: (id: string, jobId: string) => void
  /** Set by the bulk runner: failed bulk rows are re-sent through their job, not one by one. */
  onBulkRetry?: (jobId: string, ids: string[]) => void

  private api: Api
  private now: () => number
  private delays: number[]
  private listeners = new Set<Listener>()
  private keyN = 0
  private summaryCache: Summary = { queued: 0, saving: 0, failed: 0, conflict: 0, pending: 0 }
  private depth = 0
  private prevSnap = new Map<string, Deal | undefined>()
  private ev: EngineEvent = emptyEvent()
  readonly stats = { rebased: 0, retries: 0 }

  constructor(deps: EngineDeps) {
    this.api = deps.api
    this.now = deps.now ?? Date.now
    this.delays = deps.retryDelays ?? RETRY_DELAYS_MS
  }

  // ---- reading -----------------------------------------------------------------------

  subscribe(l: Listener): () => void {
    this.listeners.add(l)
    return () => this.listeners.delete(l)
  }
  summary(): Summary {
    return this.summaryCache
  }
  /** What the user sees: confirmed row + unconfirmed intents. */
  effective(id: string): Deal | undefined {
    const s = this.server.get(id)
    if (!s) return undefined
    const e = this.overlay.get(id)
    return e ? foldEntry(s, e) : s
  }
  effectiveDeals(): Iterable<Deal> {
    const self = this
    return {
      *[Symbol.iterator]() {
        for (const [id, d] of self.server) {
          const e = self.overlay.get(id)
          yield e ? foldEntry(d, e) : d
        }
      },
    }
  }
  syncOf(id: string): RowSync | undefined {
    const e = this.overlay.get(id)
    return e && { status: e.status, error: e.error, retrying: e.retrying, theirs: e.theirs, attempts: e.attempts }
  }
  pendingPatch(id: string): DealPatch | undefined {
    const e = this.overlay.get(id)
    return e && visiblePatch(e)
  }
  pendingBase(id: string): DealPatch | undefined {
    const e = this.overlay.get(id)
    return e && visibleBase(e)
  }
  hasPending(): boolean {
    return this.overlay.size > 0
  }
  loadChunk(deals: Deal[]): void {
    for (const d of deals) this.server.set(d.id, d)
  }

  // ---- transaction plumbing ----------------------------------------------------------

  /** Capture the effective row before the first mutation of `id` in this batch. */
  private touch(id: string): void {
    if (!this.prevSnap.has(id)) this.prevSnap.set(id, this.effective(id))
  }
  /** Run several mutations and emit one event for all of them. */
  batch<T>(fn: () => T): T {
    return this.tx(fn)
  }
  private tx<T>(fn: () => T): T {
    this.depth++
    try {
      return fn()
    } finally {
      if (--this.depth === 0) this.flush()
    }
  }
  private flush(): void {
    if (this.prevSnap.size === 0 && !this.hasSignals()) return
    const ev = this.ev
    for (const [id, prev] of this.prevSnap) {
      ev.touched.push(id)
      const next = this.effective(id)
      if (next && !sameDeal(prev, next)) ev.changes.push({ id, prev, next })
    }
    this.prevSnap = new Map()
    this.ev = emptyEvent()
    for (const l of this.listeners) l(ev)
  }
  private hasSignals(): boolean {
    const e = this.ev
    return !!(e.remote.length || e.acked.length || e.newFailures.length || e.newConflicts.length || e.jobSignals.length)
  }

  private setStatus(e: OverlayEntry, s: EntryStatus): void {
    if (this.overlay.get(e.id) === e) this.summaryCache = adjust(this.summaryCache, e.status, -1)
    e.status = s
    if (this.overlay.get(e.id) === e) this.summaryCache = adjust(this.summaryCache, s, 1)
    if (s === 'failed' || s === 'conflict') this.problems.add(e.id)
    else this.problems.delete(e.id)
  }
  private register(e: OverlayEntry): void {
    this.overlay.set(e.id, e)
    this.summaryCache = adjust(this.summaryCache, e.status, 1)
    if (e.status === 'failed' || e.status === 'conflict') this.problems.add(e.id)
  }
  private unregister(e: OverlayEntry): void {
    if (this.overlay.get(e.id) !== e) return
    if (e.timer) clearTimeout(e.timer)
    e.token++ // abandon any in-flight response
    this.summaryCache = adjust(this.summaryCache, e.status, -1)
    this.overlay.delete(e.id)
    this.problems.delete(e.id)
  }
  private newKey(): string {
    return `k${++this.keyN}`
  }

  // ---- user edits --------------------------------------------------------------------

  /** Optimistically apply an edit and queue it. Returns the inverse patch (for undo), or null for a no-op. */
  edit(id: string, patch: DealPatch): { inverse: DealPatch } | null {
    const server = this.server.get(id)
    if (!server) return null
    const eff = this.effective(id)!
    if (isNoop(eff, patch)) return null
    return this.tx(() => {
      this.touch(id)
      const inverse = pickFields(eff, patch)
      let e = this.overlay.get(id)
      if (!e) {
        e = { id, inflight: null, writes: [], status: 'queued', attempts: 0, retrying: false, token: 0 }
        this.register(e)
      }
      const last = e.writes[e.writes.length - 1]
      if (last && last.source === 'single') {
        // Coalesce: the queued write now carries both edits; keep the oldest base per field.
        last.patch = { ...last.patch, ...patch }
        last.base = { ...inverse, ...last.base }
        last.at = this.now()
      } else {
        const prev = last ?? e.inflight
        e.writes.push({
          key: this.newKey(), patch: { ...patch }, base: inverse, baseVersion: prev?.baseVersion ?? server.version,
          at: this.now(), source: 'single',
        })
      }
      this.pump(id)
      return { inverse }
    })
  }

  // ---- sending -----------------------------------------------------------------------

  /** Start the next write for a deal if nothing blocks it. */
  private pump(id: string): void {
    const e = this.overlay.get(id)
    if (!e || e.inflight || e.status === 'failed' || e.status === 'conflict') return
    const head = e.writes[0]
    if (!head) return
    if (head.source === 'bulk') {
      if (head.jobId) this.onBulkReady?.(id, head.jobId)
      return
    }
    this.touch(id)
    e.writes.shift()
    e.inflight = head
    e.attempts = 0
    e.retrying = false
    e.error = undefined
    this.setStatus(e, 'saving')
    void this.attempt(e, head)
  }

  private async attempt(e: OverlayEntry, w: Write): Promise<void> {
    const token = ++e.token
    const live = () => this.overlay.get(e.id) === e && e.token === token && e.inflight === w
    try {
      const res = await this.api.updateDeal({ id: e.id, patch: w.patch, baseVersion: w.baseVersion, idempotencyKey: w.key })
      if (!live()) return
      this.tx(() => {
        this.touch(e.id)
        if (res.ok) this.settleOk(e, w, res.deal)
        else this.settleConflict(e, w, res.current)
      })
    } catch (err) {
      if (!live()) return
      this.tx(() => {
        this.touch(e.id)
        this.settleError(e, w, err)
      })
    }
  }

  private settleError(e: OverlayEntry, w: Write, err: unknown): void {
    e.attempts++
    const msg = err instanceof NetworkError || err instanceof Error ? err.message : 'Save failed'
    if (e.attempts <= this.delays.length) {
      e.retrying = true
      e.error = msg
      this.stats.retries++
      const wait = this.delays[e.attempts - 1]!
      e.timer = setTimeout(() => {
        if (this.overlay.get(e.id) === e && e.inflight === w) {
          this.tx(() => {
            this.touch(e.id)
            e.retrying = false
          })
          void this.attempt(e, w)
        }
      }, wait)
      return
    }
    this.failHead(e, w, msg)
  }

  /** Put the in-flight write back at the head and mark the deal "Not saved". */
  private failHead(e: OverlayEntry, w: Write, msg: string): void {
    e.inflight = null
    e.writes.unshift(w)
    e.retrying = false
    e.error = msg
    this.setStatus(e, 'failed')
    this.ev.newFailures.push({ id: e.id, error: msg })
    if (w.jobId) this.ev.jobSignals.push({ jobId: w.jobId, id: e.id, state: 'failed' })
  }

  private settleOk(e: OverlayEntry, w: Write, deal: Deal): void {
    const cur = this.server.get(e.id)
    if (!cur || deal.version >= cur.version) this.server.set(e.id, deal)
    this.advanceChain(e, w, deal)
    e.inflight = null
    e.attempts = 0
    e.retrying = false
    e.error = undefined
    this.ev.acked.push(e.id)
    if (w.jobId) this.ev.jobSignals.push({ jobId: w.jobId, id: e.id, state: 'done' })
    if (e.writes.length === 0) this.unregister(e)
    else {
      this.setStatus(e, 'queued')
      this.pump(e.id)
    }
  }

  /** Our own write bumped the version: later queued writes were made against the old one. */
  private advanceChain(e: OverlayEntry, done: Write, deal: Deal): void {
    const oldV = done.baseVersion
    for (const x of e.writes) {
      if (x.baseVersion !== oldV) continue
      x.baseVersion = deal.version
      for (const f of patchFields(done.patch)) if (x.patch[f] !== undefined) (x.base as Record<string, unknown>)[f] = deal[f]
    }
  }

  private settleConflict(e: OverlayEntry, w: Write, current: Deal): void {
    const cur = this.server.get(e.id)
    if (!cur || current.version >= cur.version) this.server.set(e.id, current)
    e.inflight = null
    e.writes.unshift(w)
    const fields = patchFields(w.patch)
    if (fields.every((f) => current[f] === w.patch[f])) {
      // The server already has exactly what we wanted (e.g. our own write landed, or a teammate agreed).
      e.writes.shift()
      this.settleOk(e, w, current)
      return
    }
    const harmless = fields.every((f) => current[f] === w.base[f])
    if (harmless) {
      // Teammate touched other fields: rebase silently onto their version and resend.
      const oldV = w.baseVersion
      w.baseVersion = current.version
      w.key = this.newKey()
      for (const x of e.writes) if (x !== w && x.baseVersion === oldV) x.baseVersion = current.version
      this.stats.rebased++
      this.ev.rebased.push(e.id)
      e.error = undefined
      this.setStatus(e, 'queued')
      this.pump(e.id)
    } else {
      e.theirs = current
      e.error = 'A teammate changed this deal'
      this.setStatus(e, 'conflict')
      this.ev.newConflicts.push(e.id)
    }
  }

  // ---- user resolution ---------------------------------------------------------------

  /** Retry a failed deal now. A failed bulk write is retried through the single-deal path. */
  retry(id: string): void {
    const e = this.overlay.get(id)
    if (!e || e.status !== 'failed') return
    this.tx(() => {
      this.touch(id)
      const head = e.writes[0]
      if (head && head.source === 'bulk') {
        head.source = 'single'
        head.baseVersion = this.server.get(id)!.version
        head.key = this.newKey()
      }
      this.setStatus(e, 'queued')
      this.pump(id)
    })
  }
  retryAll(): number {
    const ids = [...this.problems].filter((id) => this.overlay.get(id)?.status === 'failed')
    const byJob = new Map<string, string[]>()
    this.tx(() => {
      for (const id of ids) {
        const h = this.overlay.get(id)!.writes[0]
        if (h?.source === 'bulk' && h.jobId && this.onBulkRetry) (byJob.get(h.jobId) ?? byJob.set(h.jobId, []).get(h.jobId)!).push(id)
        else this.retry(id)
      }
    })
    for (const [jobId, jobIds] of byJob) this.onBulkRetry?.(jobId, jobIds)
    return ids.length
  }
  /** Drop every unconfirmed write for a deal; the row falls back to the server's version. */
  revert(id: string): void {
    const e = this.overlay.get(id)
    if (!e) return
    this.tx(() => {
      this.touch(id)
      for (const w of allWrites(e)) if (w.jobId) this.ev.jobSignals.push({ jobId: w.jobId, id, state: 'dropped' })
      this.unregister(e)
    })
  }
  discardAll(): number {
    const ids = [...this.problems]
    this.tx(() => ids.forEach((id) => this.revert(id)))
    return ids.length
  }
  /** Conflict: keep my edit, resend on top of their version. */
  keepMine(id: string): void {
    const e = this.overlay.get(id)
    if (!e || e.status !== 'conflict' || !e.theirs) return
    this.tx(() => {
      this.touch(id)
      const head = e.writes[0]!
      const oldV = head.baseVersion
      const v = Math.max(e.theirs!.version, this.server.get(id)!.version)
      head.baseVersion = v
      head.key = this.newKey()
      for (const x of e.writes) if (x !== head && x.baseVersion === oldV) x.baseVersion = v
      e.theirs = undefined
      e.error = undefined
      this.setStatus(e, 'queued')
      this.pump(id)
    })
  }
  /** Conflict: drop my edit and show theirs (the server row already is theirs). */
  takeTheirs(id: string): void {
    const e = this.overlay.get(id)
    if (!e || e.status !== 'conflict') return
    this.revert(id)
  }

  // ---- teammate changes --------------------------------------------------------------

  /** Apply confirmed changes from other users to `server`. Idempotent: stale versions are ignored. */
  applyRemote(changes: RemoteChange[]): RemoteApplied[] {
    return this.tx(() => {
      const applied: RemoteApplied[] = []
      for (const { deal } of changes) {
        const cur = this.server.get(deal.id)
        if (cur && deal.version <= cur.version) continue
        this.touch(deal.id)
        this.server.set(deal.id, deal)
        applied.push({
          id: deal.id, prev: cur, next: deal, by: deal.updatedBy, pending: this.overlay.has(deal.id),
          fields: cur ? changedFields(cur, deal) : [],
        })
      }
      this.ev.remote.push(...applied)
      return applied
    })
  }

  // ---- bulk support (driven by bulk.ts) ----------------------------------------------

  /** Optimistically apply one patch to many deals in a single batched update. Returns per-id inverse patches. */
  applyBulk(jobId: string, ids: string[], patch: DealPatch): Map<string, DealPatch> {
    return this.tx(() => {
      const inverse = new Map<string, DealPatch>()
      const at = this.now()
      for (const id of ids) {
        const server = this.server.get(id)
        if (!server) continue
        this.touch(id)
        const eff = this.effective(id)!
        inverse.set(id, pickFields(eff, patch))
        let e = this.overlay.get(id)
        if (!e) {
          e = { id, inflight: null, writes: [], status: 'queued', attempts: 0, retrying: false, token: 0 }
          this.register(e)
        }
        const prev = e.writes[e.writes.length - 1] ?? e.inflight
        e.writes.push({
          key: this.newKey(), patch: { ...patch }, base: pickFields(eff, patch), baseVersion: prev?.baseVersion ?? server.version,
          at, source: 'bulk', jobId,
        })
      }
      return inverse
    })
  }

  /** Is this deal's next write the given job's, and free to send? */
  isBulkReady(id: string, jobId: string): boolean {
    const e = this.overlay.get(id)
    const h = e?.writes[0]
    return !!e && !e.inflight && e.status === 'queued' && !!h && h.source === 'bulk' && h.jobId === jobId
  }

  /** Move the job's head writes for `ids` onto the wire. Returns only ids that were free. */
  claimBulk(jobId: string, ids: string[]): string[] {
    const ready: string[] = []
    this.tx(() => {
      for (const id of ids) {
        if (!this.isBulkReady(id, jobId)) continue
        const e = this.overlay.get(id)!
        this.touch(id)
        e.inflight = e.writes.shift()!
        e.attempts = 0
        this.setStatus(e, 'saving')
        ready.push(id)
      }
    })
    return ready
  }

  /** A claimed bulk write was confirmed by the server. */
  bulkAck(id: string, deal: Deal): void {
    const e = this.overlay.get(id)
    const w = e?.inflight
    if (!e || !w || w.source !== 'bulk') return
    this.tx(() => {
      this.touch(id)
      this.settleOk(e, w, deal)
    })
  }
  /** A claimed bulk write failed for good (rejected item, or the chunk ran out of retries). */
  bulkFail(id: string, error: string): void {
    const e = this.overlay.get(id)
    const w = e?.inflight
    if (!e || !w || w.source !== 'bulk') return
    this.tx(() => {
      this.touch(id)
      this.failHead(e, w, error)
    })
  }
  /** Drop a job's not-yet-sent writes (cancel). In-flight ones are left to finish. */
  dropBulk(jobId: string, ids: string[]): number {
    let n = 0
    this.tx(() => {
      for (const id of ids) {
        const e = this.overlay.get(id)
        if (!e) continue
        const i = e.writes.findIndex((w) => w.jobId === jobId && w.source === 'bulk')
        if (i < 0 || (i === 0 && e.status === 'failed')) continue // failed ones stay visible for Retry/Revert
        this.touch(id)
        e.writes.splice(i, 1)
        n++
        this.ev.jobSignals.push({ jobId, id, state: 'dropped' })
        if (e.writes.length === 0 && !e.inflight) this.unregister(e)
        else this.pump(id)
      }
    })
    return n
  }
  /** Ids in `ids` currently failed because of this job. */
  failedFor(jobId: string, ids: Iterable<string>): string[] {
    const out: string[] = []
    for (const id of ids) {
      const e = this.overlay.get(id)
      if (e?.status === 'failed' && e.writes[0]?.jobId === jobId) out.push(id)
    }
    return out
  }
  /** Failed bulk write -> back to "ready for the job to re-send". */
  requeueBulk(id: string): void {
    const e = this.overlay.get(id)
    if (!e || e.status !== 'failed' || e.writes[0]?.source !== 'bulk') return
    this.tx(() => {
      this.touch(id)
      e.error = undefined
      this.setStatus(e, 'queued')
    })
  }
}

function sameDeal(a: Deal | undefined, b: Deal): boolean {
  if (a === b) return true
  if (!a) return false
  return a.version === b.version && a.stage === b.stage && a.ownerId === b.ownerId && a.valueInr === b.valueInr &&
    a.nextFollowUpAt === b.nextFollowUpAt && a.expectedCloseAt === b.expectedCloseAt && a.stageEnteredAt === b.stageEnteredAt
}

function adjust(s: Summary, status: EntryStatus, d: 1 | -1): Summary {
  return { ...s, [status]: s[status] + d, pending: s.pending + d }
}
