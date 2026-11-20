import { useEffect } from 'react'
import { useKeyboard } from '../keyboard/useKeyboard'
import { record } from '../perf'
import { useApp, useAppInstance } from '../state/hooks'
import { BulkBar } from './BulkBar'
import { DealGrid } from './DealGrid'
import { DetailPanel } from './DetailPanel'
import { CommandPalette, ConfirmDialog, ShortcutsHelp, StagePicker } from './Dialogs'
import { DevPanel } from './DevPanel'
import { Header } from './Header'
import { JobsPanel } from './JobsPanel'
import { StageRail } from './StageRail'
import { Toasts } from './Toasts'
import { UpdatesPill } from './UpdatesPill'
import { num } from './format'

const SORT_LABEL = { priority: 'priority', value: 'value', close: 'close date', activity: 'last activity', name: 'name' } as const

function Toolbar() {
  const app = useAppInstance()
  const n = useApp((a) => a.view.ids.length)
  const sort = useApp((a) => a.sort)
  const view = useApp((a) => a.filter.view)
  return (
    <div className="toolbar">
      <span><strong>{num(n)}</strong> deals</span>
      <span className="muted">sorted by {SORT_LABEL[sort.key]} {sort.dir === 'asc' ? '↑' : '↓'}</span>
      {view === 'today' && <span className="muted">· open deals that need you today</span>}
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
  const detailOpen = useApp((a) => a.ui.detailOpen)
  const devOpen = useApp((a) => a.ui.devOpen)
  const paletteOpen = useApp((a) => a.ui.paletteOpen)
  const helpOpen = useApp((a) => a.ui.helpOpen)
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
    <div className="app">
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
        {detailOpen && phase === 'ready' && <DetailPanel />}
        {devOpen && <DevPanel />}
      </div>
      <JobsPanel />
      <Toasts />
      {paletteOpen && <CommandPalette />}
      {helpOpen && <ShortcutsHelp />}
      {pickerOpen && <StagePicker />}
      {hasConfirm && <ConfirmDialog />}
    </div>
  )
}
