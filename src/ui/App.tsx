import { useEffect } from 'react'
import { isTextEntry, modalOpen, useKeyboard } from '../keyboard/useKeyboard'
import { record } from '../perf'
import { stageLabel } from '../domain/stages'
import { useApp, useAppInstance } from '../state/hooks'
import { BulkBar } from './BulkBar'
import { DealGrid } from './DealGrid'
import { DetailPanel } from './DetailPanel'
import { ConfirmDialog, NewDealDialog, StagePicker } from './Dialogs'
import { DevPanel } from './DevPanel'
import { Header } from './Header'
import { JobsPanel } from './JobsPanel'
import { StageRail } from './StageRail'
import { Toasts } from './Toasts'
import { UpdatesPill } from './UpdatesPill'
import { num } from './format'

const SORT_LABEL = { priority: 'priority', value: 'value', close: 'close date', activity: 'last activity', name: 'name' } as const
const VIEW_LABEL = { today: 'Today', mine: 'My deals', all: 'All deals', failed: 'Failed' } as const

/** Active filters, always visible above the table: "My deals · Won · 358". Stage and search have a × to drop them. */
function Toolbar() {
  const app = useAppInstance()
  const n = useApp((a) => a.view.ids.length)
  const sort = useApp((a) => a.sort)
  const view = useApp((a) => a.filter.view)
  const stage = useApp((a) => a.filter.stage)
  const query = useApp((a) => a.filter.query)
  const sep = <span className="sep" aria-hidden>·</span>
  const chip = (label: string, clear: () => void, what: string) => (
    <>
      {sep}
      <span className="fchip">
        {label}
        <button className="fx" aria-label={`Remove ${what} filter`} onClick={clear}>×</button>
      </span>
    </>
  )
  return (
    <div className="toolbar">
      <div className="filters" role="group" aria-label="Active filters">
        <strong>{VIEW_LABEL[view]}</strong>
        {stage && chip(stageLabel(stage), () => app.setFilter({ stage: null }), stage)}
        {query && chip(`“${query}”`, () => app.setFilter({ query: '' }), 'search')}
        {sep}
        <span className="count" aria-label={`${n} deals`}>{num(n)}</span>
      </div>
      <span className="muted">sorted by {SORT_LABEL[sort.key]} {sort.dir === 'asc' ? '↑' : '↓'}</span>
      {view === 'today' && !stage && <span className="muted">· open deals that need you, then deals you closed this week</span>}
      <UpdatesPill />
      <span className="spacer" />
      <button className="btn small" onClick={() => { app.rebuildView({ pin: true }); app.setUi({ gridFocus: app.ui.gridFocus + 1 }) }} title="Re-run the filter and sort with the latest data">Refresh</button>
    </div>
  )
}

function Loading() {
  const loaded = useApp((a) => a.loaded)
  const total = useApp((a) => a.total)
  return (
    <div className="center-msg" role="status">
      <p>Loading deals…</p>
      <progress max={total || 1} value={loaded} />
      <p className="muted">{num(loaded)} / {total ? num(total) : '…'}</p>
    </div>
  )
}

function LoadError() {
  const app = useAppInstance()
  const msg = useApp((a) => a.loadError)
  return (
    <div className="center-msg" role="alert">
      <p>Could not load deals: {msg}</p>
      <button className="btn" onClick={() => void app.init()}>Try again</button>
    </div>
  )
}

export function App() {
  const app = useAppInstance()
  const phase = useApp((a) => a.phase)
  const devOpen = useApp((a) => a.ui.devOpen)
  const newDealOpen = useApp((a) => a.ui.newDealOpen)
  const pickerOpen = useApp((a) => a.ui.pickerOpen)
  const hasConfirm = useApp((a) => a.confirm !== null)
  useKeyboard(app)

  // Warn before leaving while anything is unsaved or a bulk job is running.
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (app.hasPending()) {
        e.preventDefault()
        e.returnValue = ''
      }
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [app])

  // First interactive render after the data arrived.
  useEffect(() => {
    if (phase !== 'ready') return
    const t = performance.now()
    requestAnimationFrame(() => requestAnimationFrame(() => record('first-render-after-data', performance.now() - t)))
  }, [phase])

  return (
    <div
      className="app"
      onClick={(e) => {
        // After any mouse interaction the keyboard goes back to the table, so keys keep working and a focused
        // button/checkbox can't also react to Space. Text fields, sliders and dialogs keep their own focus.
        const t = e.target as HTMLElement
        if (isTextEntry(t) || t.closest('input[type="range"]') || modalOpen(app)) return
        app.setUi(t.closest('[role="grid"]') ? { zone: 'table', gridFocus: app.ui.gridFocus + 1 } : { gridFocus: app.ui.gridFocus + 1 })
      }}
    >
      <Header />
      <div className="main">
        <StageRail />
        <main className="center">
          {phase === 'loading' && <Loading />}
          {phase === 'error' && <LoadError />}
          {phase === 'ready' && (
            <>
              <Toolbar />
              <BulkBar />
              <DealGrid />
            </>
          )}
        </main>
        {phase === 'ready' && <DetailPanel />}
        {devOpen && <DevPanel />}
        <Toasts />
      </div>
      <JobsPanel />
      {newDealOpen && <NewDealDialog />}
      {pickerOpen && <StagePicker />}
      {hasConfirm && <ConfirmDialog />}
    </div>
  )
}
