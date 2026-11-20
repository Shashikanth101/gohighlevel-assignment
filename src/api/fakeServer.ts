import type { Deal, DealPatch, StageId } from '../domain/types'
import { ME } from '../domain/types'
import { STAGES } from '../domain/stages'
import { applyPatch } from '../domain/patch'
import type {
  Api, BulkItemResult, BulkRequest, ChangesResult, UpdateRequest, UpdateResult,
} from './api'
import { MAX_BULK, NetworkError } from './api'
import { makeRng, pick, randInt, type Rng } from './rng'
import { generateDeals } from './seed'
import type { SettingsStore } from './settings'

export interface FakeServerOptions {
  size: number
  seed: number
  now?: () => number
  settings: SettingsStore
  /** Chunk size for listDeals. */
  chunkSize?: number
  /** Skip all artificial delays (used by some tests). */
  instant?: boolean
}

type FailKind = 'rejected' | 'lost'
type InterfereMode = 'same' | 'other'

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
const clone = (d: Deal): Deal => ({ ...d })

/**
 * In-app stand-in for a backend. Authoritative, versioned, idempotent. All randomness comes
 * from one seeded RNG, so a scenario replays identically for the same seed and call order.
 */
export class FakeServer implements Api {
  readonly settings: SettingsStore
  private deals = new Map<string, Deal>()
  private ids: string[] = []
  private log: { seq: number; id: string }[] = []
  private seq = 0
  private idem = new Map<string, UpdateResult | BulkItemResult[]>()
  private rng: Rng
  private now: () => number
  private chunkSize: number
  private instant: boolean
  private forcedFailures: { n: number; kind?: FailKind } = { n: 0 }
  private interfere: InterfereMode | null = null
  private simTimer: ReturnType<typeof setTimeout> | null = null
  /** Counters the tests and Dev Panel can read. */
  readonly stats = { applied: 0, failedRejected: 0, failedLost: 0, interfered: 0, teammateChanges: 0 }

  constructor(opts: FakeServerOptions) {
    this.settings = opts.settings
    this.now = opts.now ?? Date.now
    this.rng = makeRng(opts.seed ^ 0x9e3779b9)
    this.chunkSize = opts.chunkSize ?? 5000
    this.instant = opts.instant ?? false
    for (const d of generateDeals(opts.size, opts.seed, this.now())) {
      this.deals.set(d.id, d)
      this.ids.push(d.id)
    }
  }

  // ---- Api ---------------------------------------------------------------------------

  async listDeals(onChunk: (deals: Deal[], loaded: number, total: number) => void): Promise<number> {
    const total = this.ids.length
    const snapshotSeq = this.seq
    for (let i = 0; i < total; i += this.chunkSize) {
      await this.gate(80, 200)
      const chunk = this.ids.slice(i, i + this.chunkSize).map((id) => clone(this.deals.get(id)!))
      onChunk(chunk, Math.min(i + this.chunkSize, total), total)
    }
    return snapshotSeq
  }

  async changesSince(seq: number): Promise<ChangesResult> {
    await this.gate(60, 200)
    const seen = new Set<string>()
    const changes: ChangesResult['changes'] = []
    for (let i = this.log.length - 1; i >= 0 && this.log[i]!.seq > seq; i--) {
      const e = this.log[i]!
      if (seen.has(e.id)) continue
      seen.add(e.id)
      changes.push({ seq: e.seq, deal: clone(this.deals.get(e.id)!) })
    }
    changes.reverse()
    return { changes, seq: this.seq }
  }

  async updateDeal(req: UpdateRequest): Promise<UpdateResult> {
    await this.gate()
    const fail = this.rollFailure()
    const stored = this.idem.get(req.idempotencyKey) as UpdateResult | undefined
    if (stored) {
      // A retry of a request we already applied: never apply twice.
      if (fail) throw this.fail('lost')
      return stored
    }
    if (fail === 'rejected') throw this.fail('rejected')
    this.maybeInterfere(req.id, req.patch)
    const result = this.doUpdate(req)
    if (result.ok) this.idem.set(req.idempotencyKey, result)
    if (fail === 'lost') throw this.fail('lost')
    return result
  }

  async bulkUpdate(req: BulkRequest): Promise<BulkItemResult[]> {
    if (req.ids.length > MAX_BULK) throw new Error(`bulkUpdate accepts at most ${MAX_BULK} ids`)
    await this.gate(0, 0, req.ids.length * 0.6)
    const fail = this.rollFailure()
    const stored = this.idem.get(req.idempotencyKey) as BulkItemResult[] | undefined
    if (stored) {
      if (fail) throw this.fail('lost')
      return stored
    }
    if (fail === 'rejected') throw this.fail('rejected')
    const itemRate = this.settings.get().bulkItemFailureRate
    const results: BulkItemResult[] = req.ids.map((id) => {
      const d = this.deals.get(id)
      if (!d) return { id, ok: false, error: 'Deal not found' }
      if (this.rng() < itemRate) return { id, ok: false, error: 'Deal is locked by another process' }
      return { id, ok: true, deal: clone(this.write(id, req.patch, ME)) }
    })
    this.idem.set(req.idempotencyKey, results)
    if (fail === 'lost') throw this.fail('lost')
    return results
  }

  // ---- internals ---------------------------------------------------------------------

  /** Offline check plus simulated latency. */
  private async gate(min?: number, max?: number, extra = 0): Promise<void> {
    const s = this.settings.get()
    if (s.offline) {
      if (!this.instant) await sleep(150)
      throw new NetworkError('offline')
    }
    if (this.instant) return
    const lo = min ?? s.latencyMin
    const hi = max ?? s.latencyMax
    await sleep(lo + this.rng() * Math.max(0, hi - lo) + extra)
  }

  private rollFailure(): FailKind | null {
    const s = this.settings.get()
    if (this.forcedFailures.n > 0) {
      this.forcedFailures.n--
      return this.forcedFailures.kind ?? (this.rng() < s.lostResponseShare ? 'lost' : 'rejected')
    }
    if (this.rng() < s.failureRate) return this.rng() < s.lostResponseShare ? 'lost' : 'rejected'
    return null
  }

  private fail(kind: FailKind): NetworkError {
    if (kind === 'lost') this.stats.failedLost++
    else this.stats.failedRejected++
    return new NetworkError(kind, kind === 'lost' ? 'Saved on the server, but the response was lost' : 'Server rejected the request')
  }

  private doUpdate(req: UpdateRequest): UpdateResult {
    const cur = this.deals.get(req.id)
    if (!cur) throw new NetworkError('rejected', 'Deal not found')
    if (cur.version !== req.baseVersion) return { ok: false, conflict: true, current: clone(cur) }
    return { ok: true, deal: clone(this.write(req.id, req.patch, ME)) }
  }

  private write(id: string, patch: DealPatch, by: number): Deal {
    const cur = this.deals.get(id)!
    const t = this.now()
    const next = applyPatch(cur, patch, t)
    next.version = cur.version + 1
    next.updatedAt = t
    next.updatedBy = by
    next.lastActivityAt = t
    this.deals.set(id, next)
    this.log.push({ seq: ++this.seq, id })
    this.stats.applied++
    return next
  }

  private maybeInterfere(id: string, patch: DealPatch): void {
    const s = this.settings.get()
    let mode = this.interfere
    if (mode) this.interfere = null
    else if (s.teammateRate > 0 && this.rng() < 0.05) mode = this.rng() < 0.5 ? 'same' : 'other'
    if (!mode) return
    const cur = this.deals.get(id)
    if (!cur) return
    const touched = Object.keys(patch)
    let teammatePatch: DealPatch
    if (mode === 'same' && touched.includes('stage')) teammatePatch = { stage: this.otherStage(cur.stage, patch.stage) }
    else if (mode === 'same' && touched.includes('valueInr')) teammatePatch = { valueInr: Math.round(cur.valueInr * 1.15) }
    else if (mode === 'same' && touched.includes('ownerId')) teammatePatch = { ownerId: 1 + ((cur.ownerId + 3) % 19) }
    else if (touched.includes('stage') || mode === 'other') teammatePatch = { valueInr: Math.round(cur.valueInr * 1.1) }
    else teammatePatch = { stage: this.otherStage(cur.stage) }
    this.stats.interfered++
    this.stats.teammateChanges++
    this.write(id, teammatePatch, randInt(this.rng, 1, 19))
  }

  private otherStage(not: StageId, also?: StageId): StageId {
    const options = STAGES.filter((s) => s.id !== not && s.id !== also)
    return pick(this.rng, options).id
  }

  // ---- teammate simulator ------------------------------------------------------------

  /** One random teammate edit. Public so tests and scenarios can drive it directly. */
  teammateChange(targetId?: string): string {
    const id = targetId ?? this.ids[Math.floor(this.rng() * this.ids.length)]!
    const cur = this.deals.get(id)!
    const by = randInt(this.rng, 1, 19)
    const roll = this.rng()
    let patch: DealPatch
    if (roll < 0.55) patch = { stage: this.otherStage(cur.stage) }
    else if (roll < 0.8) patch = { valueInr: Math.max(25_000, Math.round(cur.valueInr * (0.8 + this.rng() * 0.5))) }
    else patch = { ownerId: (cur.ownerId + randInt(this.rng, 1, 18)) % 20 }
    this.write(id, patch, by)
    this.stats.teammateChanges++
    return id
  }

  start(): void {
    this.stop()
    const loop = () => {
      const rate = this.settings.get().teammateRate
      if (rate > 0) this.teammateChange()
      this.simTimer = setTimeout(loop, rate > 0 ? 60_000 / rate : 1000)
    }
    this.simTimer = setTimeout(loop, 1000)
  }
  stop(): void {
    if (this.simTimer) clearTimeout(this.simTimer)
    this.simTimer = null
  }

  // ---- scenarios ---------------------------------------------------------------------

  failNext(n = 1, kind?: FailKind): void {
    this.forcedFailures = { n, kind }
  }
  /** The next saved deal gets a teammate edit applied just before the user's write lands. */
  interfereNext(mode: InterfereMode): void {
    this.interfere = mode
  }
  burst(n = 10): void {
    for (let i = 0; i < n; i++) this.teammateChange()
  }
  goOffline(ms = 10_000): void {
    this.settings.set({ offline: true })
    setTimeout(() => this.settings.set({ offline: false }), ms)
  }

  // ---- test / debug helpers ----------------------------------------------------------

  peek(id: string): Deal | undefined {
    const d = this.deals.get(id)
    return d && clone(d)
  }
  get size(): number {
    return this.ids.length
  }
  get currentSeq(): number {
    return this.seq
  }
  idsOwnedBy(ownerId: number): string[] {
    return this.ids.filter((id) => this.deals.get(id)!.ownerId === ownerId)
  }
}
