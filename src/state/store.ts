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
import { stageLabel } from '../domain/stages'
import type { Deal, DealPatch, SortSpec, StageId, SyncStatus, ViewFilter, ViewId } from '../domain/types'
import { ME } from '../domain/types'
import {
  adjustCounts, defaultSort, emptyScoped, matches, viewFields, type MatchCtx, type ScopedCounts,
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
  ui = { detailOpen: false, paletteOpen: false, helpOpen: false, devOpen: false, trayOpen: false, pickerOpen: false, searchFocus: 0, gridFocus: 0 }
  settingsValue: Settings
  undoDepth = 0

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
    this.clearSelection()
    this.rebuildView({ pin: false })
    done()
  }
  setView(view: ViewId): void {
    if (view === this.filter.view && !this.filter.stage && !this.filter.query) return this.rebuildView({ pin: true })
    this.setFilter({ view, stage: null, query: '' })
  }
  setStageFilter(stage: StageId | null): void {
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
    }
    for (const id of ev.touched) this.rowCache.delete(id)

    const remoteIds = new Set<string>()
    if (ev.remote.length) this.handleRemote(ev, remoteIds)

    // Rows my own action moved out of the current filter leave the list; focus advances.
    if (this.filter.view !== 'failed') {
      const gone = new Set<string>()
      for (const ch of ev.changes) {
        if (remoteIds.has(ch.id) || !snapshotHas(this.view, ch.id)) continue
        if (!matches(ch.next, this.filter, this.ctx())) gone.add(ch.id)
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
  /** Live number of deals matching the current filter (may exceed the snapshot when teammates added rows). */
  countMatching(): number {
    let n = 0
    const ctx = this.ctx()
    for (const d of this.dealsForView()) if (matches(d, this.filter, ctx)) n++
    return n
  }

  // ---- moves ----
  /** Move the selection (or the focused row) to a stage. Large moves become cancellable bulk jobs. */
  moveTo(stage: StageId): void {
    const hasSel = this.selectedCount() > 0
    if (!hasSel) {
      if (this.activeId === null) return
      this.moveOne(this.activeId, stage)
      return
    }
    const ctx = this.ctx()
    const all = Sel.materialize(this.selection, this.dealsForView(), ctx)
    const ids = all.filter((id) => this.engine.effective(id)?.stage !== stage)
    if (!ids.length) {
      this.toast({ kind: 'info', message: `Already in ${stageLabel(stage)}` })
      return
    }
    if (ids.length <= SMALL_BATCH) {
      this.moveMany(ids, stage)
      this.clearSelection()
      return
    }
    const run = () => {
      this.startBulkMove(ids, stage)
      this.clearSelection()
    }
    if (stage === 'lost' && ids.length > CONFIRM_LOST_ABOVE) {
      const byStage = new Map<StageId, number>()
      let value = 0
      for (const id of ids) {
        const d = this.engine.effective(id)!
        byStage.set(d.stage, (byStage.get(d.stage) ?? 0) + 1)
        value += d.valueInr
      }
      this.confirm = {
        title: `Move ${ids.length.toLocaleString('en-IN')} deals to Lost?`,
        lines: [
          ...[...byStage].map(([s, n]) => `${n.toLocaleString('en-IN')} from ${stageLabel(s)}`),
          `Total value ${inr(value)}`,
          'You can cancel the job or undo it afterwards.',
        ],
        confirmLabel: `Move ${ids.length.toLocaleString('en-IN')} to Lost`,
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
    const res = this.engine.edit(id, { stage })
    if (!res) {
      this.toast({ kind: 'info', message: `Already in ${stageLabel(stage)}` })
      return
    }
    const item: UndoItem = { kind: 'edit', label: `${d.name} → ${stageLabel(stage)}`, items: [{ id, patch: res.inverse }] }
    this.pushUndo(item)
    this.toast({ kind: 'success', message: `${d.name} → ${stageLabel(stage)}`, action: { label: 'Undo', run: () => this.undoItem(item) } })
  }

  private moveMany(ids: string[], stage: StageId): void {
    const items: { id: string; patch: DealPatch }[] = []
    this.engine.batch(() => {
      for (const id of ids) {
        const r = this.engine.edit(id, { stage })
        if (r) items.push({ id, patch: r.inverse })
      }
    })
    if (!items.length) return
    const item: UndoItem = { kind: 'edit', label: `${items.length} deals → ${stageLabel(stage)}`, items }
    this.pushUndo(item)
    this.toast({ kind: 'success', message: item.label, action: { label: 'Undo', run: () => this.undoItem(item) } })
  }

  startBulkMove(ids: string[], stage: StageId): Job {
    const label = `Move ${ids.length.toLocaleString('en-IN')} deals to ${stageLabel(stage)}`
    const t0 = performance.now()
    const job = this.runner.start(label, [{ patch: { stage }, ids }])
    record('bulk-optimistic-apply', performance.now() - t0, t0, `${ids.length} deals`)
    measureToPaint('bulk-apply-to-paint', t0)()
    this.pushUndo({ kind: 'job', label, jobId: job.id })
    this.say(`${label} started`)
    return job
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
