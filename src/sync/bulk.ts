/**
 * Bulk jobs: one patch applied to many deals. The optimistic overlay is applied in a single batched
 * update, then ids are sent in chunks of <= 500 with limited concurrency. Ids are materialised and
 * frozen at start. Chunk requests auto-retry (same idempotency key) before their ids are marked failed.
 */
import type { Api } from '../api/api'
import { MAX_BULK, NetworkError } from '../api/api'
import type { DealPatch } from '../domain/types'
import type { EngineEvent, SyncEngine } from './engine'
import { RETRY_DELAYS_MS } from './engine'

export const CHUNK_SIZE = MAX_BULK
export const CONCURRENCY = 2

export type JobStatus = 'running' | 'cancelling' | 'cancelled' | 'done'
export interface Job {
  id: string
  label: string
  kind: 'move' | 'undo'
  patch: DealPatch
  total: number
  done: number
  failed: number
  dropped: number
  /** Parked behind an earlier unsaved edit to the same deal; resumes by itself. */
  waiting: number
  status: JobStatus
  undone: boolean
  startedAt: number
}

type IdState = 'pending' | 'inflight' | 'done' | 'failed' | 'dropped'
interface Group {
  patch: DealPatch
  queue: string[]
  pos: number
  retry: string[]
}
interface JobState {
  job: Job
  groups: Group[]
  groupOf: Map<string, number> | null
  ids: string[]
  state: Map<string, IdState>
  parked: Set<string>
  inverse: Map<string, DealPatch>
  running: number
  cancelling: boolean
}

export interface BulkDeps {
  api: Api
  engine: SyncEngine
  now?: () => number
  retryDelays?: number[]
  chunkSize?: number
  concurrency?: number
}

type Listener = (jobs: Job[]) => void

export function groupByPatch(inverse: Map<string, DealPatch>, ids: Iterable<string>): { patch: DealPatch; ids: string[] }[] {
  const groups = new Map<string, { patch: DealPatch; ids: string[] }>()
  for (const id of ids) {
    const p = inverse.get(id)
    if (!p) continue
    const k = JSON.stringify(p)
    const g = groups.get(k) ?? groups.set(k, { patch: p, ids: [] }).get(k)!
    g.ids.push(id)
  }
  return [...groups.values()]
}

export class BulkRunner {
  private jobs = new Map<string, JobState>()
  private listeners = new Set<Listener>()
  private n = 0
  private snapshot: Job[] = []
  private pumpScheduled = new Set<string>()
  private api: Api
  private engine: SyncEngine
  private now: () => number
  private delays: number[]
  private chunkSize: number
  private concurrency: number

  constructor(deps: BulkDeps) {
    this.api = deps.api
    this.engine = deps.engine
    this.now = deps.now ?? Date.now
    this.delays = deps.retryDelays ?? RETRY_DELAYS_MS
    this.chunkSize = deps.chunkSize ?? CHUNK_SIZE
    this.concurrency = deps.concurrency ?? CONCURRENCY
    this.engine.subscribe((e) => this.onEngine(e))
    this.engine.onBulkReady = (id, jobId) => this.unpark(id, jobId)
    this.engine.onBulkRetry = (jobId, ids) => this.retryFailed(jobId, ids)
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l)
    return () => this.listeners.delete(l)
  }
  list(): Job[] {
    return this.snapshot
  }
  get(jobId: string): Job | undefined {
    return this.jobs.get(jobId)?.job
  }
  /** Ids this job confirmed (what Undo will revert). */
  doneIds(jobId: string): string[] {
    const js = this.jobs.get(jobId)
    return js ? js.ids.filter((id) => js.state.get(id) === 'done') : []
  }

  /** Start a job. `groups` is usually one {patch, ids}; Undo uses one group per distinct inverse patch. */
  start(label: string, groups: { patch: DealPatch; ids: string[] }[], kind: Job['kind'] = 'move'): Job {
    const id = `job${++this.n}`
    const ids: string[] = []
    const state = new Map<string, IdState>()
    for (const g of groups) for (const x of g.ids) { ids.push(x); state.set(x, 'pending') }
    let groupOf: Map<string, number> | null = null
    if (groups.length > 1) {
      groupOf = new Map()
      groups.forEach((g, i) => g.ids.forEach((x) => groupOf!.set(x, i)))
    }
    const js: JobState = {
      job: {
        id, label, kind, patch: groups[0]?.patch ?? {}, total: ids.length, done: 0, failed: 0, dropped: 0, waiting: 0,
        status: 'running', undone: false, startedAt: this.now(),
      },
      groups: groups.map((g) => ({ patch: g.patch, queue: g.ids, pos: 0, retry: [] })),
      groupOf,
      ids,
      state,
      parked: new Set(),
      inverse: new Map(),
      running: 0,
      cancelling: false,
    }
    this.jobs.set(id, js)
    // One batched optimistic update for the whole job.
    this.engine.batch(() => {
      for (const g of groups) {
        for (const [k, v] of this.engine.applyBulk(id, g.ids, g.patch)) js.inverse.set(k, v)
      }
    })
    this.publish()
    this.pump(js)
    return js.job
  }

  cancel(jobId: string): void {
    const js = this.jobs.get(jobId)
    if (!js || js.job.status !== 'running') return
    js.cancelling = true
    const unsent: string[] = []
    for (const [id, st] of js.state) if (st === 'pending') unsent.push(id)
    for (const g of js.groups) {
      g.queue = []
      g.pos = 0
      g.retry = []
    }
    js.parked.clear()
    this.engine.dropBulk(jobId, unsent)
    this.refresh(js)
  }

  /** Re-send failed ids of a job (all of them, or just `only`). */
  retryFailed(jobId: string, only?: string[]): number {
    const js = this.jobs.get(jobId)
    if (!js) return 0
    const candidates = only ?? js.ids.filter((id) => js.state.get(id) === 'failed')
    let n = 0
    this.engine.batch(() => {
      for (const id of candidates) {
        if (js.state.get(id) !== 'failed') continue
        const gi = js.groupOf?.get(id) ?? 0
        this.engine.requeueBulk(id)
        if (!this.engine.isBulkReady(id, jobId)) continue // converted to a single write by a row-level Retry
        js.state.set(id, 'pending')
        js.groups[gi]!.retry.push(id)
        js.job.failed--
        n++
      }
    })
    if (n) {
      js.cancelling = false
      this.refresh(js)
      this.pump(js)
    }
    return n
  }

  /** Revert everything the job did (confirmed rows via a new job; failed rows are discarded). */
  undo(jobId: string): Job | null {
    const js = this.jobs.get(jobId)
    if (!js || js.job.status === 'running' || js.job.status === 'cancelling' || js.job.undone) return null
    const done = this.doneIds(jobId)
    for (const id of js.ids) if (js.state.get(id) === 'failed') this.engine.revert(id)
    js.job.undone = true
    this.publish()
    const groups = groupByPatch(js.inverse, done)
    if (!groups.length) return null
    return this.start(`Undo: ${js.job.label}`, groups, 'undo')
  }

  dismiss(jobId: string): void {
    const js = this.jobs.get(jobId)
    if (!js || js.job.status === 'running' || js.job.status === 'cancelling') return
    this.jobs.delete(jobId)
    this.publish()
  }

  // ---- scheduling --------------------------------------------------------------------

  private schedulePump(js: JobState): void {
    if (this.pumpScheduled.has(js.job.id)) return
    this.pumpScheduled.add(js.job.id)
    queueMicrotask(() => {
      this.pumpScheduled.delete(js.job.id)
      this.pump(js)
    })
  }

  private unpark(id: string, jobId: string): void {
    const js = this.jobs.get(jobId)
    if (!js || !js.parked.delete(id)) return
    js.groups[js.groupOf?.get(id) ?? 0]!.retry.push(id)
    this.schedulePump(js)
  }

  private nextChunk(js: JobState): { gi: number; ids: string[] } | null {
    for (let gi = 0; gi < js.groups.length; gi++) {
      const g = js.groups[gi]!
      while (g.retry.length || g.pos < g.queue.length) {
        let candidates: string[]
        if (g.retry.length) candidates = g.retry.splice(0, this.chunkSize)
        else {
          candidates = g.queue.slice(g.pos, g.pos + this.chunkSize)
          g.pos += candidates.length
        }
        const ready = this.engine.claimBulk(js.job.id, candidates)
        if (ready.length !== candidates.length) {
          const got = new Set(ready)
          for (const id of candidates) if (!got.has(id) && js.state.get(id) === 'pending') js.parked.add(id)
        }
        if (ready.length) return { gi, ids: ready }
      }
    }
    return null
  }

  private pump(js: JobState): void {
    while (!js.cancelling && js.running < this.concurrency) {
      const chunk = this.nextChunk(js)
      if (!chunk) break
      for (const id of chunk.ids) js.state.set(id, 'inflight')
      js.running++
      void this.runChunk(js, chunk).finally(() => {
        js.running--
        this.pump(js)
        this.refresh(js)
      })
    }
    this.refresh(js)
  }

  private async runChunk(js: JobState, chunk: { gi: number; ids: string[] }): Promise<void> {
    const key = `${js.job.id}-c${++this.n}`
    const patch = js.groups[chunk.gi]!.patch
    for (let attempt = 0; ; attempt++) {
      try {
        const results = await this.api.bulkUpdate({ ids: chunk.ids, patch, idempotencyKey: key })
        const byId = new Map(results.map((r) => [r.id, r]))
        this.engine.batch(() => {
          for (const id of chunk.ids) {
            const r = byId.get(id)
            if (r?.ok && r.deal) this.engine.bulkAck(id, r.deal)
            else this.engine.bulkFail(id, r?.error ?? 'No result returned')
          }
        })
        return
      } catch (err) {
        const delay = this.delays[attempt]
        if (err instanceof NetworkError && delay !== undefined) {
          await new Promise((r) => setTimeout(r, delay))
          continue
        }
        const msg = err instanceof Error ? err.message : 'Request failed'
        this.engine.batch(() => chunk.ids.forEach((id) => this.engine.bulkFail(id, msg)))
        return
      }
    }
  }

  // ---- bookkeeping -------------------------------------------------------------------

  private onEngine(e: EngineEvent): void {
    if (!e.jobSignals.length) return
    const touched = new Set<JobState>()
    for (const s of e.jobSignals) {
      const js = this.jobs.get(s.jobId)
      if (!js) continue
      const prev = js.state.get(s.id)
      if (!prev) continue
      touched.add(js)
      if (prev === 'failed') js.job.failed--
      if (s.state === 'done') {
        js.state.set(s.id, 'done')
        if (prev !== 'done') js.job.done++
      } else if (s.state === 'failed') {
        js.state.set(s.id, 'failed')
        js.job.failed++
      } else {
        js.state.set(s.id, 'dropped')
        js.job.dropped++
      }
    }
    for (const js of touched) this.refresh(js)
  }

  private refresh(js: JobState): void {
    const g = js.groups
    const hasQueued = g.some((x) => x.retry.length > 0 || x.pos < x.queue.length)
    const busy = js.running > 0 || hasQueued
    const j = js.job
    const status: JobStatus = busy ? (js.cancelling ? 'cancelling' : 'running') : js.cancelling ? 'cancelled' : 'done'
    j.waiting = js.parked.size
    if (status !== j.status) j.status = status
    this.publish()
  }

  private publish(): void {
    // Fresh object per job so selectors see a change; cheap because jobs are few.
    this.snapshot = [...this.jobs.values()].map((s) => ({ ...s.job }))
    for (const l of this.listeners) l(this.snapshot)
  }
}
