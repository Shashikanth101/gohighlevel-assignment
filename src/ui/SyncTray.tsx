import { useEffect, useRef } from 'react'
import { stageLabel } from '../domain/stages'
import { userName } from '../domain/users'
import { useApp, useAppInstance } from '../state/hooks'
import type { PipelineApp, RowView } from '../state/store'
import { inr, num } from './format'

/** One plain sentence about what the teammate did, e.g. "Arjun moved this to Lost". */
export function describeTheirs(app: PipelineApp, row: RowView): string {
  const t = row.theirs
  if (!t) return 'A teammate changed this deal'
  const by = userName(t.updatedBy)
  const mine = app.engine.pendingPatch(row.id) ?? {}
  const parts: string[] = []
  if (mine.stage !== undefined && t.stage !== mine.stage) parts.push(`moved this to ${stageLabel(t.stage)}`)
  if (mine.valueInr !== undefined && t.valueInr !== mine.valueInr) parts.push(`set the value to ${inr(t.valueInr)}`)
  if (mine.ownerId !== undefined && t.ownerId !== mine.ownerId) parts.push(`reassigned it to ${userName(t.ownerId)}`)
  return `${by} ${parts.length ? parts.join(' and ') : 'changed this'}`
}

export function describeMine(app: PipelineApp, id: string): string {
  const p = app.engine.pendingPatch(id) ?? {}
  const parts: string[] = []
  if (p.stage) parts.push(`→ ${stageLabel(p.stage)}`)
  if (p.valueInr !== undefined) parts.push(`value ${inr(p.valueInr)}`)
  if (p.ownerId !== undefined) parts.push(`owner ${userName(p.ownerId)}`)
  return parts.join(', ')
}

function TrayItem({ id }: { id: string }) {
  const app = useAppInstance()
  const row = useApp((a) => a.getRow(id))
  if (!row) return null
  return (
    <li className={`tray-item ${row.status}`}>
      <div className="tray-main">
        <button className="link" onClick={() => app.setActive(id)} title="Focus this deal if it is in the list">{row.deal.name}</button>
        <span className="muted"> {describeMine(app, id)}</span>
        <div className="tray-msg">{row.status === 'conflict' ? describeTheirs(app, row) : row.error}</div>
      </div>
      <div className="tray-actions">
        {row.status === 'failed' && <button className="mini" onClick={() => app.retry(id)}>Retry</button>}
        {row.status === 'conflict' && (
          <>
            <button className="mini" onClick={() => app.keepMine(id)}>Keep mine</button>
            <button className="mini" onClick={() => app.takeTheirs(id)}>Take theirs</button>
          </>
        )}
        <button className="mini" onClick={() => app.revert(id)}>{row.status === 'conflict' ? 'Discard mine' : 'Revert'}</button>
      </div>
    </li>
  )
}

export function SyncTray() {
  const app = useAppInstance()
  const s = useApp((a) => a.summary)
  const open = useApp((a) => a.ui.trayOpen)
  const online = useApp((a) => a.online)
  const jobs = useApp((a) => a.jobs)
  const panel = useRef<HTMLDivElement>(null)
  const problems = s.failed + s.conflict
  const saving = s.saving + s.queued
  const label = problems ? `${num(problems)} not saved` : saving ? `Saving ${num(saving)}` : 'All saved'
  const cls = problems ? 'bad' : saving ? 'busy' : 'ok'

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node
      if (!panel.current?.contains(t) && !(t as HTMLElement).closest?.('.tray-btn')) app.setUi({ trayOpen: false })
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open, app])

  const ids = open ? app.problemIds() : []
  return (
    <div className="tray">
      <button className={`btn tray-btn ${cls}`} aria-expanded={open} aria-controls="sync-tray" onClick={() => app.setUi({ trayOpen: !open })}>
        <span className="dot" aria-hidden /> {label}
      </button>
      {open && (
        <div id="sync-tray" ref={panel} className="tray-panel" role="dialog" aria-label="Sync tray">
          <div className="tray-head">
            <strong>Sync</strong>
            <span className="muted">
              Saving {num(saving)} · Not saved {num(s.failed)} · Conflicts {num(s.conflict)}
            </span>
          </div>
          {!online && <p className="tray-note">You are offline. Unsaved changes are kept here; they retry automatically when you reconnect.</p>}
          {jobs.some((j) => j.status === 'running') && <p className="tray-note">A bulk job is running; its rows are counted above.</p>}
          {problems === 0 ? (
            <p className="muted pad">{saving ? 'Saving in the background. Nothing needs you.' : 'Everything is saved.'}</p>
          ) : (
            <>
              <div className="tray-bar">
                <button className="btn" disabled={s.failed === 0} onClick={() => app.retryAll()}>Retry all</button>
                <button className="btn" onClick={() => app.discardAll()}>Discard all</button>
              </div>
              <ul className="tray-list">
                {ids.slice(0, 50).map((id) => <TrayItem key={id} id={id} />)}
              </ul>
              {ids.length > 50 && <p className="muted pad">…and {num(ids.length - 50)} more. Use the Failed view to work through them.</p>}
              <div className="pad"><button className="btn" onClick={() => { app.setView('failed'); app.setUi({ trayOpen: false, gridFocus: app.ui.gridFocus + 1 }) }}>Open Failed view</button></div>
            </>
          )}
        </div>
      )}
    </div>
  )
}
