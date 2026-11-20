import { useEffect, useRef, useState } from 'react'
import { priority } from '../domain/priority'
import { STAGES, stageLabel } from '../domain/stages'
import { userName } from '../domain/users'
import { useApp, useAppInstance } from '../state/hooks'
import { inr, rel } from './format'
import { describeMine, describeTheirs } from './SyncTray'

export function DetailPanel() {
  const app = useAppInstance()
  const id = useApp((a) => a.activeId)
  const row = useApp((a) => (a.activeId ? a.getRow(a.activeId) : undefined))
  const now = useApp((a) => a.view.now)
  const [value, setValue] = useState('')
  const editing = useRef(false)
  // A teammate's change must never overwrite text the user is typing (open edits are pinned).
  useEffect(() => {
    if (!editing.current) setValue(row ? String(row.deal.valueInr) : '')
  }, [row?.deal.valueInr, id]) // eslint-disable-line react-hooks/exhaustive-deps

  const close = () => {
    app.setUi({ detailOpen: false, gridFocus: app.ui.gridFocus + 1 })
  }
  if (!row || !id) {
    return (
      <aside className="detail" aria-label="Deal details">
        <p className="muted pad">No deal focused.</p>
        <button className="btn" onClick={close}>Close</button>
      </aside>
    )
  }
  const d = row.deal
  const p = priority(d, now)
  const commitValue = () => {
    const n = Math.round(Number(value.replace(/[, ]/g, '')))
    if (Number.isFinite(n) && n > 0 && n !== d.valueInr) app.editDeal(id, { valueInr: n })
    else setValue(String(d.valueInr))
  }
  return (
    <aside className="detail" aria-label={`Details: ${d.name}`}>
      <div className="detail-head">
        <h2>{d.name}</h2>
        <button className="btn small" onClick={close} aria-label="Close details">Close (Esc)</button>
      </div>
      <p className="muted">{d.id} · {stageLabel(d.stage)} · owner {userName(d.ownerId)}</p>

      {row.status === 'failed' && (
        <div className="callout bad" role="group" aria-label="Not saved">
          <strong>Not saved.</strong> {row.error}. Your change is kept: {describeMine(app, id)}.
          <div className="callout-actions">
            <button className="btn" onClick={() => app.retry(id)}>Retry</button>
            <button className="btn" onClick={() => app.revert(id)}>Revert</button>
          </div>
        </div>
      )}
      {row.status === 'conflict' && (
        <div className="callout warn" role="group" aria-label="Conflict">
          <strong>{describeTheirs(app, row)}.</strong> You wanted: {describeMine(app, id)}.
          <div className="callout-actions">
            <button className="btn" onClick={() => app.keepMine(id)}>Keep mine</button>
            <button className="btn" onClick={() => app.takeTheirs(id)}>Take theirs</button>
          </div>
        </div>
      )}
      {row.status === 'saving' && <p className="muted">{row.retrying ? 'Retrying…' : 'Saving…'}</p>}

      {p.reasons.length > 0 && (
        <div className="chips big">{p.reasons.map((r) => <span key={r.kind} className={`chip chip-${r.kind}`}>{r.label}</span>)}</div>
      )}

      <h3>Stage</h3>
      <div className="stage-buttons" role="group" aria-label="Move to stage">
        {STAGES.map((s) => (
          <button key={s.id} className={`btn small ${d.stage === s.id ? 'on' : ''}`} aria-pressed={d.stage === s.id} onClick={() => app.moveOne(id, s.id)}>
            <kbd>{s.key}</kbd> {s.label}
          </button>
        ))}
      </div>

      <h3>Value</h3>
      <label className="field">
        <span className="sr-only">Value in rupees</span>
        <input value={value} inputMode="numeric" onFocus={() => (editing.current = true)} onChange={(e) => setValue(e.target.value)} onBlur={() => { editing.current = false; commitValue() }} onKeyDown={(e) => e.key === 'Enter' && (e.currentTarget.blur())} />
        <span className="muted"> {inr(d.valueInr)} · {d.licences} licences</span>
      </label>

      <dl className="facts">
        <dt>Next follow-up</dt><dd>{rel(d.nextFollowUpAt, now)}</dd>
        <dt>Expected close</dt><dd>{rel(d.expectedCloseAt, now)}</dd>
        <dt>In stage since</dt><dd>{rel(d.stageEnteredAt, now)}</dd>
        <dt>Last activity</dt><dd>{rel(d.lastActivityAt, now)}</dd>
        <dt>Last changed by</dt><dd>{d.updatedBy === 0 ? 'You' : userName(d.updatedBy)}</dd>
        <dt>Version</dt><dd>{d.version}</dd>
      </dl>
    </aside>
  )
}
