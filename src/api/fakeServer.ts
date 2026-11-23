import type { Deal, DealPatch, StageId } from '../domain/types'
import { ME } from '../domain/types'
import { STAGES } from '../domain/stages'
import { applyPatch, stageMovePatch } from '../domain/patch'
import { buildNewDeal, validateNewDeal } from '../domain/newDeal'
import type {
  Api, BulkItemResult, BulkRequest, ChangesResult, CreateRequest, UpdateRequest, UpdateResult,
} from './api'
import { AUTO_ATTEMPTS, MAX_BULK, NetworkError } from './api'
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

/**
 * Dev scenarios for the NEXT SAVE. Each binds to the first new write request (a request key not seen before) and
 * only ever affects that save: other deals, bulk chunks and older retries are left alone, and reads (listDeals,
 * changesSince) never count.
 *  - fail-all:  every automatic attempt of that save fails, so it ends "Not saved". A manual Retry then succeeds.
 *  - fail-once: one attempt fails; the engine's automatic retry recovers quietly.
 *  - lost-once: the server applies the write but the response is lost; the retry must not apply it twice.
 */
export type ScenarioKind = 'fail-all' | 'fail-once' | 'lost-once'
interface Armed {
  kind: ScenarioKind
  /** fail-all: how many attempts fail (the client's automatic budget). */
  attempts: number
  bound?: { key: string; label: string; failed: number }
}

export type RequestOutcome = 'ok' | 'replayed' | 'failed' | 'response lost' | 'conflict' | 'offline'
export interface RequestLogEntry {
  n: number
  kind: 'save' | 'bulk' | 'create'
  /** What was being saved, e.g. "Vertex Pharma → contacted". */
  label: string
  /** Which send of this request this is (the same idempotency key counts up: 1, 2, 3 …). */
  attempt: number
  outcome: RequestOutcome
  cause?: 'scenario' | 'random'
}
export interface DevState {
  /** Human-readable lines for every scenario that is waiting or in progress. */
  armed: string[]
  /** The last write requests, newest first. */
  log: RequestLogEntry[]
}
const LOG_SIZE = 10

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
  private idem = new Map<string, UpdateResult | BulkItemResult[] | Deal>()
  private rng: Rng
  private now: () => number
  private chunkSize: number
  private instant: boolean
  private forcedFailures: { n: number; kind?: FailKind } = { n: 0 }
  /** Scenarios waiting for a save, or mid-flight on one. They queue: each binds to a different save, in order. */
  private armed: Armed[] = []
  private seen = new Map<string, number>()
  private requestLog: RequestLogEntry[] = []
  private logSeq = 0
  private devSnap: DevState = { armed: [], log: [] }
  private devListeners = new Set<() => void>()
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
    const label = this.saveLabel(req)
    const attempt = this.attemptOf(req.idempotencyKey)
    this.bind(req.idempotencyKey, label, attempt)
    await this.gateLogged('save', label, attempt)
    const f = this.decide(req.idempotencyKey)
    const stored = this.idem.get(req.idempotencyKey) as UpdateResult | undefined
    if (stored) {
      // A retry of a request we already applied: never apply twice.
      if (f.kind) throw this.failed('save', label, attempt, 'lost', f.cause)
      this.record('save', label, attempt, 'replayed')
      return stored
    }
    if (f.kind === 'rejected') throw this.failed('save', label, attempt, 'rejected', f.cause)
    this.maybeInterfere(req.id, req.patch)
    const result = this.doUpdate(req)
    if (result.ok) this.idem.set(req.idempotencyKey, result)
    if (f.kind === 'lost') throw this.failed('save', label, attempt, 'lost', f.cause)
    this.record('save', label, attempt, result.ok ? 'ok' : 'conflict')
    return result
  }

  async bulkUpdate(req: BulkRequest): Promise<BulkItemResult[]> {
    if (req.ids.length > MAX_BULK) throw new Error(`bulkUpdate accepts at most ${MAX_BULK} ids`)
    const label = `bulk · ${req.ids.length} deals`
    const attempt = this.attemptOf(req.idempotencyKey)
    this.bind(req.idempotencyKey, label, attempt)
    await this.gateLogged('bulk', label, attempt, req.ids.length * 0.6)
    const f = this.decide(req.idempotencyKey)
    const stored = this.idem.get(req.idempotencyKey) as BulkItemResult[] | undefined
    if (stored) {
      if (f.kind) throw this.failed('bulk', label, attempt, 'lost', f.cause)
      this.record('bulk', label, attempt, 'replayed')
      return stored
    }
    if (f.kind === 'rejected') throw this.failed('bulk', label, attempt, 'rejected', f.cause)
    const itemRate = this.settings.get().bulkItemFailureRate
    const results: BulkItemResult[] = req.ids.map((id) => {
      const d = this.deals.get(id)
      if (!d) return { id, ok: false, error: 'Deal not found' }
      if (this.rng() < itemRate) return { id, ok: false, error: 'Deal is locked by another process' }
      return { id, ok: true, deal: clone(this.write(id, req.patch, ME)) }
    })
    this.idem.set(req.idempotencyKey, results)
    if (f.kind === 'lost') throw this.failed('bulk', label, attempt, 'lost', f.cause)
    this.record('bulk', label, attempt, 'ok')
    return results
  }

  async createDeal(req: CreateRequest): Promise<Deal> {
    const label = `create “${req.input.name.trim()}”`
    const attempt = this.attemptOf(req.idempotencyKey)
    this.bind(req.idempotencyKey, label, attempt)
    await this.gateLogged('create', label, attempt)
    const f = this.decide(req.idempotencyKey)
    const stored = this.idem.get(req.idempotencyKey) as Deal | undefined
    if (stored) {
      // A retry of a create we already applied: hand back the same deal, never make a second one.
      if (f.kind) throw this.failed('create', label, attempt, 'lost', f.cause)
      this.record('create', label, attempt, 'replayed')
      return clone(stored)
    }
    if (f.kind === 'rejected') throw this.failed('create', label, attempt, 'rejected', f.cause)
    const invalid = validateNewDeal(req.input)
    if (invalid) throw new NetworkError('rejected', invalid)
    const deal = buildNewDeal(`D-${String(this.ids.length + 1).padStart(5, '0')}`, req.input, this.now(), 1)
    this.deals.set(deal.id, deal)
    this.ids.push(deal.id)
    this.log.push({ seq: ++this.seq, id: deal.id })
    this.stats.applied++
    this.idem.set(req.idempotencyKey, deal)
    if (f.kind === 'lost') throw this.failed('create', label, attempt, 'lost', f.cause)
    this.record('create', label, attempt, 'ok')
    return clone(deal)
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

  /** Random and legacy-hook failures (the Failure rate slider, `failNext`). Writes only: reads never call this. */
  private rollFailure(): { kind: FailKind | null; cause?: 'scenario' | 'random' } {
    const s = this.settings.get()
    if (this.forcedFailures.n > 0) {
      this.forcedFailures.n--
      return { kind: this.forcedFailures.kind ?? (this.rng() < s.lostResponseShare ? 'lost' : 'rejected'), cause: 'scenario' }
    }
    if (this.rng() < s.failureRate) return { kind: this.rng() < s.lostResponseShare ? 'lost' : 'rejected', cause: 'random' }
    return { kind: null }
  }

  // ---- write-request bookkeeping: scenarios, the request log ------------------------

  private attemptOf(key: string): number {
    const n = (this.seen.get(key) ?? 0) + 1
    this.seen.set(key, n)
    return n
  }
  private saveLabel(req: UpdateRequest): string {
    const name = this.deals.get(req.id)?.name ?? req.id
    const what = Object.entries(req.patch).map(([k, v]) => (k === 'stage' ? `→ ${String(v)}` : `${k} ${String(v)}`)).slice(0, 2).join(', ')
    return `${name} ${what}`.trim()
  }

  /** Offline check plus latency, logged as "offline" when it throws. */
  private async gateLogged(kind: RequestLogEntry['kind'], label: string, attempt: number, extra = 0): Promise<void> {
    try {
      await this.gate(kind === 'bulk' ? 0 : undefined, kind === 'bulk' ? 0 : undefined, extra)
    } catch (e) {
      this.record(kind, label, attempt, 'offline')
      throw e
    }
  }

  /** "The next save" = the first NEW write request sent after arming. Bound when it is sent, not when it arrives. */
  private bind(key: string, label: string, attempt: number): void {
    const next = this.armed.find((x) => !x.bound)
    if (!next || attempt !== 1) return
    next.bound = { key, label, failed: 0 }
    this.emitDev()
  }

  /** Should this write request fail? A scenario aimed at the next save wins; then the legacy hook; then the random rate. */
  private decide(key: string): { kind: FailKind | null; cause?: 'scenario' | 'random' } {
    const a = this.armed.find((x) => x.bound?.key === key)
    if (a?.bound) {
      if (a.kind === 'fail-all') {
        a.bound.failed++
        if (a.bound.failed >= a.attempts) this.armed = this.armed.filter((x) => x !== a)
        this.emitDev()
        return { kind: 'rejected', cause: 'scenario' }
      }
      this.armed = this.armed.filter((x) => x !== a)
      this.emitDev()
      return { kind: a.kind === 'lost-once' ? 'lost' : 'rejected', cause: 'scenario' }
    }
    return this.rollFailure()
  }

  private record(kind: RequestLogEntry['kind'], label: string, attempt: number, outcome: RequestOutcome, cause?: 'scenario' | 'random'): void {
    this.requestLog = [{ n: ++this.logSeq, kind, label, attempt, outcome, cause }, ...this.requestLog].slice(0, LOG_SIZE)
    this.emitDev()
  }
  /** Count the failure, log it, and hand back the error to throw. */
  private failed(kind: RequestLogEntry['kind'], label: string, attempt: number, fk: FailKind, cause?: 'scenario' | 'random'): NetworkError {
    this.record(kind, label, attempt, fk === 'lost' ? 'response lost' : 'failed', cause)
    return this.fail(fk)
  }

  // ---- what the Dev Panel shows ----

  private describeArmed(): string[] {
    const out: string[] = []
    for (const a of this.armed) {
      if (a.bound && a.kind === 'fail-all') out.push(`Failing every attempt of “${a.bound.label}” (${a.bound.failed} of ${a.attempts} so far)`)
      else if (a.bound) out.push(`Armed: “${a.bound.label}” is being sent`)
      else if (a.kind === 'fail-all') out.push('Armed: the next save will fail on every attempt (ends Not saved)')
      else if (a.kind === 'fail-once') out.push('Armed: the next save will fail once (the retry recovers)')
      else out.push('Armed: the next save will be applied, but its response lost')
    }
    if (this.forcedFailures.n > 0) out.push(`Armed: the next ${this.forcedFailures.n} write request(s) will fail`)
    if (this.interfere) out.push(`Armed: the next save collides with a teammate edit (${this.interfere === 'same' ? 'same field' : 'different field, silent rebase'})`)
    return out
  }
  private emitDev(): void {
    this.devSnap = { armed: this.describeArmed(), log: this.requestLog }
    for (const l of this.devListeners) l()
  }
  getDev = (): DevState => this.devSnap
  subscribeDev = (l: () => void): (() => void) => {
    this.devListeners.add(l)
    return () => this.devListeners.delete(l)
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
    if (mode) {
      this.interfere = null
      this.emitDev()
    }
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
    this.write(id, this.withStageRule(cur, teammatePatch), randInt(this.rng, 1, 19))
  }

  /** A teammate closing or reopening a deal changes its next step the same way a user's move does. */
  private withStageRule(cur: Deal, patch: DealPatch): DealPatch {
    return patch.stage ? { ...patch, ...stageMovePatch(cur, patch.stage, this.now()) } : patch
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
    this.write(id, this.withStageRule(cur, patch), by)
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

  /** The next save fails on every automatic attempt, so it ends "Not saved" (and shows in the Failed view and tray). */
  armFailAll(attempts = AUTO_ATTEMPTS): void {
    this.armed = [...this.armed, { kind: 'fail-all', attempts }]
    this.emitDev()
  }
  /** The next save fails once; the engine's automatic retry recovers (a quiet retry). */
  armFailOnce(): void {
    this.armed = [...this.armed, { kind: 'fail-once', attempts: 1 }]
    this.emitDev()
  }
  /** The next save is applied but its response is lost; the retry must not apply it twice. */
  armResponseLost(): void {
    this.armed = [...this.armed, { kind: 'lost-once', attempts: 1 }]
    this.emitDev()
  }
  disarm(): void {
    this.armed = []
    this.forcedFailures = { n: 0 }
    this.interfere = null
    this.emitDev()
  }
  /** Low-level hook (tests): the next `n` write REQUESTS of any kind fail. Prefer the armed scenarios above. */
  failNext(n = 1, kind?: FailKind): void {
    this.forcedFailures = { n, kind }
    this.emitDev()
  }
  /** The next saved deal gets a teammate edit applied just before the user's write lands. */
  interfereNext(mode: InterfereMode): void {
    this.interfere = mode
    this.emitDev()
  }
  /** `n` teammate changes. If `visible` is given, every other change targets one of those ids (rows the user is looking at). */
  burst(n = 10, visible?: readonly string[]): void {
    for (let i = 0; i < n; i++) {
      const target = visible?.length && i % 2 === 0 ? visible[Math.floor(this.rng() * visible.length)] : undefined
      this.teammateChange(target)
    }
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
