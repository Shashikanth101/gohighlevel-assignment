/**
 * PipelineApp: the framework-free application store. It owns the sync engine, the bulk runner, the
 * view snapshot, selection, deferral of teammate changes, undo and toasts. React only subscribes.
 *
 * Readers use `useApp(selector)`: selectors must return referentially-stable values, which is how a
 * change to one deal re-renders only that deal's row.
 */
import type { Api } from '../api/api'
import type { FakeServer } from '../api/fakeServer'
import { SettingsStore, type Settings } from '../api/settings'
import { STAGES, adjacentStage, stageLabel } from '../domain/stages'
import { validateNewDeal, type NewDealInput } from '../domain/newDeal'
import { moveKind, movePatch, stageMovePatch } from '../domain/patch'
import type { Deal, DealPatch, SortSpec, StageId, SyncStatus, ViewFilter, ViewId } from '../domain/types'
import { ME } from '../domain/types'
import {
  adjustCounts, defaultSort, emptyCounts, emptyScoped, matches, viewFields, type MatchCtx, type ScopedCounts, type StageCounts,
} from '../domain/selectors'
import { SyncEngine, type EngineEvent, type Summary } from '../sync/engine'
import { BulkRunner, type Job } from '../sync/bulk'
import { Feed } from '../sync/feed'
import { UndoStack, type UndoItem } from '../sync/undo'
import { measure, measureToPaint, record } from '../perf'
import { inr } from '../ui/format'
import { createSnapshot, pinFocus, removeIds, snapshotHas, type ViewSnapshot } from './viewSnapshot'
import * as Sel from './selection'

export const SMALL_BATCH = 25 // up to this many deals a multi-select move is tracked per deal; above it becomes a job
export const CONFIRM_LOST_ABOVE = 50

export interface RowView {
  id: string
  deal: Deal
  status: SyncStatus
  error?: string
  retrying: boolean
  /** Teammate's version when status === 'conflict'. */
  theirs?: Deal
  /** Bumped when a teammate patched this row in place (drives the highlight). */
  flash: number
  /** Briefly true after a save is confirmed. */
  saved: boolean
  /** A teammate changed a field that would reorder/remove this row; it moves on the next refresh. */
  deferredBy?: number
}

export interface SelectionSummary {
  count: number
  value: number
  byStage: StageCounts
}

export interface Toast {
  id: number
  key?: string
  kind: 'info' | 'success' | 'error'
  message: string
  action?: { label: string; run: () => void }
  persistent?: boolean
}
export interface ConfirmState {
  title: string
  lines: string[]
  confirmLabel: string
  run: () => void
}
export interface DeferredState {
  rows: ReadonlyMap<string, { by: number; fields: string[] }>
  entering: ReadonlySet<string>
  count: number
}
const NO_DEFERRED: DeferredState = { rows: new Map(), entering: new Set(), count: 0 }

export interface AppDeps {
  api: Api
  server?: FakeServer
  settings?: SettingsStore
  now?: () => number
  retryDelays?: number[]
}

type Listener = () => void

export class PipelineApp {
  readonly api: Api
  readonly server?: FakeServer
  readonly settings: SettingsStore
  readonly engine: SyncEngine
  readonly runner: BulkRunner
  readonly undoStack = new UndoStack()
  private feed: Feed
  private now: () => number

  // ---- observable state (replace, never mutate) ----
  phase: 'loading' | 'ready' | 'error' = 'loading'
  loaded = 0
  total = 0
  loadError = ''
  filter: ViewFilter = { view: 'today', stage: null, query: '' }
  sort: SortSpec = defaultSort('today')
  view: ViewSnapshot = { ids: [], filter: this.filter, sort: this.sort, now: 0, version: 0 }
  counts: ScopedCounts = emptyScoped()
  /**
   * Per-stage counts for the current scope when `counts.all/mine` can't answer it (Today, Failed, or a search is active).
   * Ignores the stage filter, so the rail always shows what each stage click would list. Null otherwise.
   */
  scoped: StageCounts | null = null
  deferred: DeferredState = NO_DEFERRED
  selection: Sel.Selection = Sel.EMPTY_SELECTION
  /** Live number of deals matching the selection's filter (for "N selected" in filter mode). */
  selMatching = 0
  anchorId: string | null = null
  activeId: string | null = null
  summary: Summary
  online = true
  jobs: Job[] = []
  toasts: Toast[] = []
  liveAssertive = ''
  livePolite = ''
  confirm: ConfirmState | null = null
  ui = {
    devOpen: false, trayOpen: false, pickerOpen: false, newDealOpen: false, searchFocus: 0, gridFocus: 0,
    /** Which keyboard zone owns the arrows: the stage rail or the table. */
    zone: 'table' as 'table' | 'rail',
    /**
     * Where W/S have moved the rail cursor ahead of applying it: 0 = All stages, 1..7 = STAGES[i - 1]. Null means
     * "on the active stage filter": the cursor is DERIVED from the filter (see `railIndex()`), and any filter change,
     * view switch or × resets it to null, so it can never disagree with the highlighted stage.
     */
    railCursor: null as number | null,
  }
  settingsValue: Settings
  undoDepth = 0
  /** Key whose key-up a dialog wants swallowed (the one that confirmed it); see useKeyboard. */
  swallowKeyUp: string | null = null

  // ---- internals ----
  private listeners = new Set<Listener>()
  private rowCache = new Map<string, RowView>()
  private flash = new Map<string, number>()
  private flashSeq = 0
  private saved = new Set<string>()
  private toastSeq = 0
  private viewVersion = 0
  private vf = new Set<string>()

  constructor(deps: AppDeps) {
    this.api = deps.api
    this.server = deps.server
    this.now = deps.now ?? Date.now
    this.settings = deps.settings ?? deps.server?.settings ?? new SettingsStore()
    this.settingsValue = this.settings.get()
    this.engine = new SyncEngine({ api: deps.api, now: this.now, retryDelays: deps.retryDelays })
    this.runner = new BulkRunner({ api: deps.api, engine: this.engine, now: this.now, retryDelays: deps.retryDelays })
    this.summary = this.engine.summary()
    this.feed = new Feed(deps.api, this.engine, {
      pollMs: () => this.settings.get().pollMs,
      onConnection: (online) => this.onConnection(online),
    })
    this.engine.subscribe((e) => this.onEngine(e))
    this.runner.subscribe((jobs) => {
      this.jobs = jobs
      this.emit()
    })
    this.settings.subscribe((s) => {
      this.settingsValue = s
      this.emit()
    })
  }

  // ---- subscription ----
  subscribe = (l: Listener): (() => void) => {
    this.listeners.add(l)
    return () => this.listeners.delete(l)
  }
  private emit(): void {
    for (const l of this.listeners) l()
  }

  // ---- loading ----
  async init(): Promise<void> {
    this.phase = 'loading'
    this.loadError = ''
    this.emit()
    const t0 = performance.now()
    try {
      const seq = await this.api.listDeals((chunk, loaded, total) => {
        this.engine.loadChunk(chunk)
        this.loaded = loaded
        this.total = total
        this.emit()
      })
      record('data-load', performance.now() - t0, t0, `${this.engine.server.size} deals`)
      this.counts = measure('counts-init', () => this.computeCounts())
      this.rebuildView({ pin: false })
      this.phase = 'ready'
      this.feed.start(seq)
      this.server?.start()
      this.emit()
    } catch (e) {
      this.phase = 'error'
      this.loadError = e instanceof Error ? e.message : 'Could not load deals'
      this.emit()
    }
  }
  dispose(): void {
    this.feed.stop()
    this.server?.stop()
  }
  /** Poll the change feed immediately (scenarios use this so the effect is visible at once). */
  pollNow(): Promise<void> {
    return this.feed.pollNow()
  }

  /** The filter the rail's counts describe: the current view and search, without the stage. Null when the incremental all/mine counts already are that. */
  private scopeFilter(): ViewFilter | null {
    const { view, query } = this.filter
    if (view === 'mine' || view === 'all') return query ? { view, stage: null, query } : null
    return { view, stage: null, query }
  }
  private computeScoped(ctx: MatchCtx): StageCounts | null {
    const f = this.scopeFilter()
    if (!f) return null
    const c = emptyCounts()
    for (const d of this.dealsForView()) {
      if (!matches(d, f, ctx)) continue
      c[d.stage].count++
      c[d.stage].value += d.valueInr
    }
    return c
  }

  private computeCounts(): ScopedCounts {
    const c = emptyScoped()
    for (const d of this.engine.effectiveDeals()) adjustCounts(c, undefined, d)
    return c
  }

  // ---- rows ----
  getRow(id: string): RowView | undefined {
    let r = this.rowCache.get(id)
    if (r) return r
    const deal = this.engine.effective(id)
    if (!deal) return undefined
    const sync = this.engine.syncOf(id)
    r = {
      id, deal, status: sync ? sync.status : 'synced', error: sync?.error, retrying: sync?.retrying ?? false,
      theirs: sync?.theirs, flash: this.flash.get(id) ?? 0, saved: this.saved.has(id),
      deferredBy: this.deferred.rows.get(id)?.by,
    }
    this.rowCache.set(id, r)
    return r
  }
  private ctx(now = this.view.now || this.now()): MatchCtx {
    return { now, isFailed: (id) => this.engine.problems.has(id) }
  }
  private dealsForView(): Iterable<Deal> {
    if (this.filter.view !== 'failed') return this.engine.effectiveDeals()
    const out: Deal[] = []
    for (const id of this.engine.problems) {
      const d = this.engine.effective(id)
      if (d) out.push(d)
    }
    return out
  }

  // ---- view ----
  /** Rebuild the snapshot. Only called on user actions (filter, sort, refresh, apply updates). */
  rebuildView(opts: { pin?: boolean; keepDeferred?: boolean } = {}): void {
    const old = this.view
    const ctx = this.ctx(this.now())
    const t0 = performance.now()
    this.view = createSnapshot(this.dealsForView(), this.filter, this.sort, ctx, ++this.viewVersion)
    record('view-build', performance.now() - t0, t0, `${this.view.ids.length} rows, ${this.filter.view}`)
    this.vf = viewFields(this.filter, this.sort)
    this.scoped = this.computeScoped(ctx)
    this.activeId = pinFocus(old.ids, opts.pin === false ? null : this.activeId, this.view.ids)
    if (!opts.keepDeferred) {
      const touched = [...this.deferred.rows.keys()]
      this.deferred = NO_DEFERRED
      for (const id of touched) this.rowCache.delete(id)
    }
    this.emit()
  }

  setFilter(patch: Partial<ViewFilter>): void {
    const done = measureToPaint('filter-change-to-paint')
    const viewChanged = patch.view !== undefined && patch.view !== this.filter.view
    this.filter = { ...this.filter, ...patch }
    if (viewChanged) this.sort = defaultSort(this.filter.view)
    this.ui = { ...this.ui, railCursor: null } // the rail cursor follows the filter again
    this.clearSelection()
    this.rebuildView({ pin: false })
    done()
  }
  setView(view: ViewId): void {
    if (view === this.filter.view && !this.filter.stage && !this.filter.query) return this.rebuildView({ pin: true })
    this.setFilter({ view, stage: null, query: '' })
  }
  setStageFilter(stage: StageId | null): void {
    // A stage is a filter on the current view, in every view (Today included).
    this.setFilter({ stage: this.filter.stage === stage ? null : stage })
  }
  setQuery(query: string): void {
    if (query === this.filter.query) return
    this.setFilter({ query })
  }
  setSort(key: SortSpec['key']): void {
    const done = measureToPaint('sort-change-to-paint')
    this.sort = this.sort.key === key ? { key, dir: this.sort.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: key === 'name' ? 'asc' : 'desc' }
    this.rebuildView({ pin: true })
    done()
  }
  /** "N updates · Show": apply deferred teammate changes to the view order. Focus and selection stay pinned. */
  applyDeferred(): void {
    if (this.deferred.count === 0) return
    this.rebuildView({ pin: true })
    this.say(`Showing latest changes, ${this.view.ids.length} deals`)
  }

  // ---- engine events ----
  private onEngine(ev: EngineEvent): void {
    // Counts and totals: incremental, from effective-row diffs.
    if (ev.changes.length) {
      const c: ScopedCounts = { all: { ...this.counts.all }, mine: { ...this.counts.mine } }
      for (const k of Object.keys(c.all) as StageId[]) {
        c.all[k] = { ...c.all[k] }
        c.mine[k] = { ...c.mine[k] }
      }
      for (const ch of ev.changes) adjustCounts(c, ch.prev, ch.next)
      this.counts = c
      const f = this.scoped && this.scopeFilter()
      if (f) {
        const ctx = this.ctx()
        const sc = emptyCounts()
        for (const k of Object.keys(sc) as StageId[]) sc[k] = { ...this.scoped![k] }
        for (const ch of ev.changes) {
          if (ch.prev && matches(ch.prev, f, ctx)) { sc[ch.prev.stage].count--; sc[ch.prev.stage].value -= ch.prev.valueInr }
          if (ch.next && matches(ch.next, f, ctx)) { sc[ch.next.stage].count++; sc[ch.next.stage].value += ch.next.valueInr }
        }
        this.scoped = sc
      }
    }
    for (const id of ev.touched) this.rowCache.delete(id)
    for (const r of ev.replaced) this.swapId(r.from, r.to)

    const remoteIds = new Set<string>()
    if (ev.remote.length) this.handleRemote(ev, remoteIds)

    // Rows my own action moved out of the current filter leave the list; focus advances.
    if (this.filter.view !== 'failed') {
      const gone = new Set<string>()
      for (const ch of ev.changes) {
        if (remoteIds.has(ch.id) || !snapshotHas(this.view, ch.id)) continue
        if (!ch.next || !matches(ch.next, this.filter, this.ctx())) gone.add(ch.id)
      }
      if (gone.size) this.removeFromView(gone)
    } else if (
      ev.newFailures.length || ev.newConflicts.length ||
      ev.touched.some((id) => snapshotHas(this.view, id) && !this.engine.problems.has(id))
    ) {
      this.rebuildView({ pin: true, keepDeferred: true })
    }

    if (ev.acked.length && ev.acked.length <= 200) this.markSaved(ev.acked)
    this.summary = this.engine.summary()
    this.announce(ev)
    this.emit()
  }

  private handleRemote(ev: EngineEvent, remoteIds: Set<string>): void {
    let rows: Map<string, { by: number; fields: string[] }> | null = null
    let entering: Set<string> | null = null
    for (const r of ev.remote) {
      // My own writes echo back through the feed; the overlay path already handled their view effects.
      if (r.by === ME) continue
      remoteIds.add(r.id)
      const inView = snapshotHas(this.view, r.id)
      const touchesView = this.filter.view !== 'failed' && r.fields.some((f) => this.vf.has(f))
      if (touchesView) {
        if (inView) {
          rows ??= new Map(this.deferred.rows)
          const prev = rows.get(r.id)
          rows.set(r.id, { by: r.by, fields: [...new Set([...(prev?.fields ?? []), ...r.fields])] })
        } else if (matches(this.engine.effective(r.id)!, this.filter, this.ctx())) {
          entering ??= new Set(this.deferred.entering)
          entering.add(r.id)
        }
      } else if (inView) {
        this.flash.set(r.id, ++this.flashSeq)
      }
    }
    if (rows || entering) {
      const rr = rows ?? this.deferred.rows
      const ee = entering ?? this.deferred.entering
      this.deferred = { rows: rr, entering: ee, count: rr.size + ee.size }
    }
  }

  /** A created deal got its real id: keep its place in the list, the focus and the selection. */
  private swapId(from: string, to: string): void {
    if (snapshotHas(this.view, from)) {
      this.view = snapshotHas(this.view, to)
        ? removeIds(this.view, new Set([from]))
        : { ...this.view, ids: this.view.ids.map((id) => (id === from ? to : id)), set: undefined }
    }
    if (this.activeId === from) this.activeId = to
    if (this.anchorId === from) this.anchorId = to
    const sel = this.selection
    if (sel.kind === 'ids' && sel.ids.has(from)) {
      const ids = new Set(sel.ids)
      ids.delete(from)
      ids.add(to)
      this.selection = { kind: 'ids', ids }
    } else if (sel.kind === 'filter' && sel.excluded.has(from)) {
      const excluded = new Set(sel.excluded)
      excluded.delete(from)
      excluded.add(to)
      this.selection = { kind: 'filter', filter: sel.filter, excluded }
    }
    this.rowCache.delete(from)
    this.rowCache.delete(to)
  }

  private removeFromView(gone: ReadonlySet<string>): void {
    const old = this.view
    this.view = removeIds(old, gone)
    this.activeId = pinFocus(old.ids, this.activeId, this.view.ids)
    if (this.deferred.count) {
      const rows = new Map(this.deferred.rows)
      for (const id of gone) rows.delete(id)
      this.deferred = { rows, entering: this.deferred.entering, count: rows.size + this.deferred.entering.size }
    }
  }

  private markSaved(ids: string[]): void {
    for (const id of ids) {
      this.saved.add(id)
      this.rowCache.delete(id)
    }
    setTimeout(() => {
      for (const id of ids) {
        this.saved.delete(id)
        this.rowCache.delete(id)
      }
      this.emit()
    }, 1800)
  }

  private announce(ev: EngineEvent): void {
    const s = this.summary
    if (ev.newFailures.length) {
      const first = ev.newFailures[0]!
      const name = this.engine.effective(first.id)?.name ?? first.id
      const msg = s.failed === 1 ? `Not saved: ${name}` : `${s.failed} changes not saved`
      this.liveAssertive = `${msg}. ${first.error}. Open the sync tray to retry.`
      this.toast({
        key: 'failures', kind: 'error', persistent: true, message: `${msg}. ${first.error}.`,
        action: s.failed === 1 ? { label: 'Retry', run: () => this.engine.retry(first.id) } : { label: 'Open tray', run: () => this.setUi({ trayOpen: true }) },
      })
    }
    if (ev.newConflicts.length) {
      const id = ev.newConflicts[0]!
      const name = this.engine.effective(id)?.name ?? id
      this.liveAssertive = `Conflict on ${name}: a teammate changed it. Open the sync tray to resolve.`
      this.toast({
        key: 'conflicts', kind: 'error', persistent: true,
        message: s.conflict === 1 ? `Conflict: a teammate changed ${name}.` : `${s.conflict} conflicts with teammate changes.`,
        action: { label: 'Resolve', run: () => this.setUi({ trayOpen: true }) },
      })
    }
    if (s.failed === 0) this.dismissToastKey('failures')
    if (s.conflict === 0) this.dismissToastKey('conflicts')
  }

  private onConnection(online: boolean): void {
    this.online = online
    if (online) {
      // Anything that failed only because we were offline is safe to resend.
      const n = this.engine.retryAll((_id, s) => /offline/i.test(s.error ?? ''))
      if (n) {
        this.toast({ kind: 'info', message: `Back online. Retrying ${n} unsaved ${n === 1 ? 'change' : 'changes'}.` })
      } else this.toast({ kind: 'info', message: 'Back online.' })
      this.livePolite = 'Back online'
    } else {
      this.toast({ key: 'offline', kind: 'error', persistent: true, message: 'You are offline. Changes will be kept and need a retry once the connection is back.' })
      this.livePolite = 'You are offline'
    }
    if (online) this.dismissToastKey('offline')
    this.emit()
  }

  // ---- toasts / announcements ----
  toast(t: Omit<Toast, 'id'>): number {
    const id = ++this.toastSeq
    const toast: Toast = { ...t, id }
    this.toasts = [...this.toasts.filter((x) => !(t.key && x.key === t.key)), toast].slice(-4)
    if (!t.persistent) setTimeout(() => this.dismissToast(id), t.action ? 8000 : 4500)
    this.emit()
    return id
  }
  dismissToast(id: number): void {
    if (!this.toasts.some((t) => t.id === id)) return
    this.toasts = this.toasts.filter((t) => t.id !== id)
    this.emit()
  }
  private dismissToastKey(key: string): void {
    if (this.toasts.some((t) => t.key === key)) this.toasts = this.toasts.filter((t) => t.key !== key)
  }
  say(msg: string): void {
    this.livePolite = msg
  }
  setUi(patch: Partial<typeof this.ui>): void {
    this.ui = { ...this.ui, ...patch }
    this.emit()
  }

  // ---- keyboard zones ----
  setZone(zone: 'table' | 'rail'): void {
    this.setUi({ zone, railCursor: null }) // entering the rail puts the cursor on the active stage
    this.say(zone === 'rail' ? 'Stage list' : 'Deals table')
  }
  /** The rail cursor: the stage W/S have moved to, else the active stage filter. 0 = All stages. */
  railIndex(): number {
    if (this.ui.railCursor !== null) return this.ui.railCursor
    return this.filter.stage ? STAGES.findIndex((s) => s.id === this.filter.stage) + 1 : 0
  }
  moveRail(delta: number): void {
    this.setUi({ railCursor: Math.max(0, Math.min(STAGES.length, this.railIndex() + delta)) })
  }
  /** Space in the rail: apply (or clear) the stage under the cursor. */
  activateRail(): void {
    const i = this.railIndex()
    this.setStageFilter(i === 0 ? null : STAGES[i - 1]!.id)
  }

  // ---- cursor and selection ----
  activeIndex(): number {
    return this.activeId === null ? -1 : this.view.ids.indexOf(this.activeId)
  }
  setActive(id: string | null): void {
    if (id === this.activeId) return
    this.activeId = id
    this.emit()
  }
  moveCursor(delta: number, extend = false): void {
    const ids = this.view.ids
    if (!ids.length) return
    this.moveCursorTo(this.activeIndex() + delta, extend)
  }
  moveCursorTo(index: number, extend = false): void {
    const ids = this.view.ids
    const to = ids[Math.max(0, Math.min(ids.length - 1, index))]
    if (to === undefined) return
    const from = this.activeId
    if (extend && from !== null) {
      this.anchorId ??= from
      this.selection = Sel.extendSelection(this.selection, ids, this.anchorId, from, to)
    }
    this.activeId = to
    this.emit()
  }
  toggleActiveSelected(): void {
    if (this.activeId === null) return
    this.selection = Sel.toggle(this.selection, this.activeId)
    this.anchorId = this.activeId
    this.emit()
  }
  /** Shift+click: select the range between the anchor and `id`. */
  selectRangeTo(id: string): void {
    const anchor = this.anchorId ?? this.activeId ?? id
    this.selection = Sel.selectRange(this.selection, this.view.ids, anchor, id)
    this.anchorId ??= anchor
    this.activeId = id
    this.emit()
  }
  toggleSelected(id: string): void {
    this.selection = Sel.toggle(this.selection, id)
    this.anchorId = id
    this.activeId = id
    this.emit()
  }
  selectAllInView(): void {
    this.selection = Sel.selectAllInView(this.view.ids)
    this.selMatching = this.countMatching()
    this.say(`${this.view.ids.length} deals selected`)
    this.emit()
  }
  selectAllMatching(): void {
    this.selMatching = this.countMatching()
    this.selection = Sel.selectAllMatching(this.filter)
    this.say(`All ${this.selMatching} matching deals selected`)
    this.emit()
  }
  clearSelection(): void {
    if (this.selection.kind === 'ids' && this.selection.ids.size === 0) return
    this.selection = Sel.EMPTY_SELECTION
    this.anchorId = null
    this.emit()
  }
  selectedCount(): number {
    return Sel.selectionCount(this.selection, this.selMatching)
  }
  /** What the detail panel shows for a multi-selection. Cached per selection and data version so selectors stay stable. */
  selectionSummary(): SelectionSummary | null {
    const n = this.selectedCount()
    if (n === 0) return null
    const c = this.sumCache
    if (c && c.sel === this.selection && c.counts === this.counts && c.n === n) return c.value
    const byStage = emptyCounts()
    const sel = this.selection
    const deals: Iterable<Deal | undefined> =
      sel.kind === 'ids' ? [...sel.ids].map((id) => this.engine.effective(id)) : Sel.materialize(sel, this.dealsForView(), this.ctx()).map((id) => this.engine.effective(id))
    let value = 0
    for (const d of deals) {
      if (!d) continue
      byStage[d.stage].count++
      byStage[d.stage].value += d.valueInr
      value += d.valueInr
    }
    const out = { count: n, value, byStage }
    this.sumCache = { sel: this.selection, counts: this.counts, n, value: out }
    return out
  }
  private sumCache: { sel: Sel.Selection; counts: ScopedCounts; n: number; value: SelectionSummary } | null = null

  /** Live number of deals matching the current filter (may exceed the snapshot when teammates added rows). */
  countMatching(): number {
    let n = 0
    const ctx = this.ctx()
    for (const d of this.dealsForView()) if (matches(d, this.filter, ctx)) n++
    return n
  }

  // ---- moves ----
  // Every stage change is built by `movePatch` (domain/patch.ts): closing clears the next step, reopening sets
  // defaults, and the inverse patch used by undo restores all of it. Groups below share one patch each, so a
  // 10,000-deal job still sends a handful of distinct patches.

  /** Split deals into groups that can share one patch, given where each one is going (null = skip it). */
  private planMove(ids: Iterable<string>, target: (d: Deal) => StageId | null): { patch: DealPatch; ids: string[]; to: StageId }[] {
    const now = this.now()
    const groups = new Map<string, { patch: DealPatch; ids: string[]; to: StageId }>()
    for (const id of ids) {
      const d = this.engine.effective(id)
      const to = d && !this.engine.isCreating(id) ? target(d) : null
      if (!d || !to || to === d.stage) continue
      const kind = moveKind(d.stage, to)
      const key = `${to}:${kind}`
      let g = groups.get(key)
      if (!g) groups.set(key, (g = { patch: movePatch(kind, to, now), ids: [], to }))
      g.ids.push(id)
    }
    return [...groups.values()]
  }

  /** Dispatch planned moves: tracked per deal when small, one cancellable job when large. */
  private dispatchMoves(groups: { patch: DealPatch; ids: string[]; to: StageId }[], label: string, jobLabel: string): void {
    const total = groups.reduce((n, g) => n + g.ids.length, 0)
    if (total <= SMALL_BATCH) this.moveMany(groups, label)
    else this.startBulk(jobLabel, groups, total)
    // The move is dispatched: the selection is spent, even if some selected deals had nowhere to go.
    this.clearSelection()
  }

  /** Move the selection (or the focused row) to a stage. Large moves become cancellable bulk jobs. */
  moveTo(stage: StageId): void {
    const hasSel = this.selectedCount() > 0
    if (!hasSel) {
      if (this.activeId === null) return
      this.moveOne(this.activeId, stage)
      return
    }
    const all = Sel.materialize(this.selection, this.dealsForView(), this.ctx())
    const groups = this.planMove(all, () => stage)
    const ids = groups.flatMap((g) => g.ids)
    if (!ids.length) {
      this.toast({ kind: 'info', message: `Already in ${stageLabel(stage)}` })
      return
    }
    const n = ids.length.toLocaleString('en-IN')
    const run = () => this.dispatchMoves(groups, `${n} deals → ${stageLabel(stage)}`, `Move ${n} deals to ${stageLabel(stage)}`)
    if (stage === 'lost' && ids.length > CONFIRM_LOST_ABOVE) {
      const byStage = new Map<StageId, number>()
      let value = 0
      for (const id of ids) {
        const d = this.engine.effective(id)!
        byStage.set(d.stage, (byStage.get(d.stage) ?? 0) + 1)
        value += d.valueInr
      }
      this.confirm = {
        title: `Move ${n} deals to Lost?`,
        lines: [
          ...[...byStage].map(([s, c]) => `${c.toLocaleString('en-IN')} from ${stageLabel(s)}`),
          `Total value ${inr(value)}`,
          'You can cancel the job or undo it afterwards.',
        ],
        confirmLabel: `Move ${n} to Lost`,
        run,
      }
      this.emit()
      return
    }
    run()
  }

  resolveConfirm(ok: boolean): void {
    const c = this.confirm
    this.confirm = null
    this.emit()
    if (ok && c) c.run()
  }

  /** Move one specific deal (not the selection). Records undo and shows the Undo toast. */
  moveOne(id: string, stage: StageId): void {
    const d = this.engine.effective(id)
    if (!d) return
    if (this.engine.isCreating(id)) {
      this.toast({ kind: 'info', message: 'Still saving this new deal. Try again in a moment.' })
      return
    }
    const res = this.engine.edit(id, stageMovePatch(d, stage, this.now()))
    if (!res) {
      this.toast({ kind: 'info', message: `Already in ${stageLabel(stage)}` })
      return
    }
    const item: UndoItem = { kind: 'edit', label: `${d.name} → ${stageLabel(stage)}`, items: [{ id, patch: res.inverse }] }
    this.pushUndo(item)
    this.toast({ kind: 'success', message: `${d.name} → ${stageLabel(stage)}`, action: { label: 'Undo', run: () => this.undoItem(item) } })
  }

  /** L / J: move the selection (or the focused deal) one stage along or back. Each deal moves from its own stage. */
  moveRelative(dir: 1 | -1): void {
    const hasSel = this.selectedCount() > 0
    const ids = hasSel ? Sel.materialize(this.selection, this.dealsForView(), this.ctx()) : this.activeId !== null ? [this.activeId] : []
    const groups = this.planMove(ids, (d) => adjacentStage(d.stage, dir))
    const total = groups.reduce((n, g) => n + g.ids.length, 0)
    if (!total) {
      if (ids.length) this.toast({ kind: 'info', message: dir === 1 ? 'Nothing to advance: already in the last open stage, or closed.' : 'Nothing to move back: already in the first stage.' })
      return
    }
    if (total === 1) {
      this.moveOne(groups[0]!.ids[0]!, groups[0]!.to)
      // The move is dispatched: the selection is spent, even if the other selected deals had nowhere to go.
      if (hasSel) this.clearSelection()
      return
    }
    this.dispatchMoves(groups, `${total} deals moved ${dir === 1 ? 'forward' : 'back'}`, `Move ${total.toLocaleString('en-IN')} deals ${dir === 1 ? 'forward' : 'back'} one stage`)
  }

  private moveMany(groups: { patch: DealPatch; ids: string[]; to: StageId }[], label: string): void {
    const items: { id: string; patch: DealPatch }[] = []
    this.engine.batch(() => {
      for (const g of groups) {
        for (const id of g.ids) {
          const r = this.engine.edit(id, g.patch)
          if (r) items.push({ id, patch: r.inverse })
        }
      }
    })
    if (!items.length) return
    const item: UndoItem = { kind: 'edit', label, items }
    this.pushUndo(item)
    this.toast({ kind: 'success', message: item.label, action: { label: 'Undo', run: () => this.undoItem(item) } })
  }

  startBulkMove(ids: string[], stage: StageId): Job {
    const groups = this.planMove(ids, () => stage)
    return this.startBulk(`Move ${ids.length.toLocaleString('en-IN')} deals to ${stageLabel(stage)}`, groups, ids.length)
  }

  private startBulk(label: string, groups: { patch: DealPatch; ids: string[] }[], count: number): Job {
    const t0 = performance.now()
    const job = this.runner.start(label, groups.map((g) => ({ patch: g.patch, ids: g.ids })))
    record('bulk-optimistic-apply', performance.now() - t0, t0, `${count} deals`)
    measureToPaint('bulk-apply-to-paint', t0)()
    this.pushUndo({ kind: 'job', label, jobId: job.id })
    this.say(`${label} started`)
    return job
  }

  /** Create a New Lead. It appears at once under a temporary id; the sync engine confirms, retries or fails it like a move. */
  createDeal(input: NewDealInput): string | null {
    if (validateNewDeal(input)) return null
    const id = this.engine.create(input)
    // Make sure the user sees it: if the current list wouldn't include it, go where New Leads live.
    if (matches(this.engine.effective(id)!, this.filter, this.ctx(this.now()))) this.rebuildView({ pin: false })
    else this.setFilter({ view: 'mine', stage: 'new', query: '' })
    this.activeId = id
    this.ui = { ...this.ui, zone: 'table', gridFocus: this.ui.gridFocus + 1 }
    this.toast({ kind: 'success', message: `Created ${input.name.trim()} in New Lead` })
    this.say(`Created ${input.name.trim()}`)
    this.emit()
    return id
  }

  /** Edit one field of one deal (detail panel). */
  editDeal(id: string, patch: DealPatch): void {
    const res = this.engine.edit(id, patch)
    if (!res) return
    const name = this.engine.effective(id)?.name ?? id
    this.pushUndo({ kind: 'edit', label: `Edit ${name}`, items: [{ id, patch: res.inverse }] })
  }

  // ---- undo ----
  private pushUndo(item: UndoItem): void {
    this.undoStack.push(item)
    this.undoDepth = this.undoStack.size
  }
  undo(): void {
    const item = this.undoStack.pop()
    this.undoDepth = this.undoStack.size
    if (!item) {
      this.toast({ kind: 'info', message: 'Nothing to undo' })
      return
    }
    this.perform(item)
  }
  undoItem(item: UndoItem): void {
    this.undoStack.remove(item)
    this.undoDepth = this.undoStack.size
    this.perform(item)
  }
  private perform(item: UndoItem): void {
    if (item.kind === 'edit') {
      // A normal new mutation that goes through the same queue; nothing is "rolled back".
      this.engine.batch(() => item.items.forEach((i) => this.engine.edit(i.id, i.patch)))
      this.toast({ kind: 'info', message: `Undid: ${item.label}` })
    } else {
      const j = this.runner.get(item.jobId)
      if (j && (j.status === 'running' || j.status === 'cancelling')) {
        this.runner.cancel(item.jobId)
        this.toast({ kind: 'info', message: 'Job cancelled. Press Undo on the job to revert what already saved.' })
        this.undoStack.push(item)
        this.undoDepth = this.undoStack.size
      } else {
        this.runner.undo(item.jobId)
        this.toast({ kind: 'info', message: `Undoing: ${item.label}` })
      }
    }
    this.emit()
  }
  undoJob(jobId: string): void {
    this.runner.undo(jobId)
    this.emit()
  }

  // ---- sync tray ----
  retry(id: string): void { this.engine.retry(id) }
  revert(id: string): void { this.engine.revert(id) }
  keepMine(id: string): void { this.engine.keepMine(id) }
  takeTheirs(id: string): void { this.engine.takeTheirs(id) }
  retryAll(): void {
    const n = this.engine.retryAll()
    this.say(`Retrying ${n} unsaved changes`)
  }
  discardAll(): void {
    const n = this.engine.discardAll()
    this.say(`Discarded ${n} unsaved changes`)
  }
  problemIds(): string[] {
    return [...this.engine.problems]
  }

  // ---- misc ----
  isMine(d: Deal): boolean {
    return d.ownerId === ME
  }
  hasPending(): boolean {
    return this.engine.hasPending() || this.runner.list().some((j) => j.status === 'running' || j.status === 'cancelling')
  }
}
