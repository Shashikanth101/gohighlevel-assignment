import { useEffect, useRef, useState } from 'react'
import { whyChips } from '../domain/priority'
import { STAGES, isTerminal, stageLabel } from '../domain/stages'
import { userName } from '../domain/users'
import { useApp, useAppInstance } from '../state/hooks'
import { Chips } from './Chips'
import { closedAgo, closeCell, inr, num, rel } from './format'
import { describeMine, describeTheirs } from './SyncTray'

function DealDetail() {
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

  if (!row || !id) return null
  const d = row.deal
  const why = whyChips(d, now)
  const commitValue = () => {
    const n = Math.round(Number(value.replace(/[, ]/g, '')))
    if (Number.isFinite(n) && n > 0 && n !== d.valueInr) app.editDeal(id, { valueInr: n })
    else setValue(String(d.valueInr))
  }
  return (
    <>
      <div className="detail-head">
        <h2>{d.name}</h2>
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

      {why.length > 0 && (
        <div className="chips-big"><Chips reasons={why} /></div>
      )}

      <h3>Stage</h3>
      <div className="stage-buttons" role="group" aria-label="Move to stage">
        {STAGES.map((s) => (
          <button key={s.id} className={`btn small ${d.stage === s.id ? 'on' : ''}`} aria-pressed={d.stage === s.id} onClick={() => app.moveOne(id, s.id)}>
            {s.label}
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
        {!isTerminal(d.stage) && <><dt>{d.stage === 'new' ? 'Contact by' : 'Next step'}</dt><dd>{rel(d.nextFollowUpAt, now)}</dd></>}
        <dt>Licences</dt><dd>{d.licences}</dd>
        {isTerminal(d.stage)
          ? <><dt>Closed</dt><dd>{closedAgo(d, now)}</dd></>
          : <><dt>Expected close</dt><dd className={closeCell(d, now).tone === 'overdue' ? 'overdue' : ''}>{closeCell(d, now).text}</dd></>}
        <dt>In stage since</dt><dd>{rel(d.stageEnteredAt, now)}</dd>
        <dt>Last activity</dt><dd>{rel(d.lastActivityAt, now)}</dd>
        <dt>Last changed by</dt><dd>{d.updatedBy === 0 ? 'You' : userName(d.updatedBy)}</dd>
        <dt>Version</dt><dd>{d.version}</dd>
      </dl>
    </>
  )
}

function SelectionDetail() {
  const app = useAppInstance()
  const sum = useApp((a) => a.selectionSummary())
  if (!sum) return null
  return (
    <>
      <h2>{num(sum.count)} {sum.count === 1 ? 'deal' : 'deals'} selected</h2>
      <p className="muted">Total value {inr(sum.value)}</p>
      <h3>By stage</h3>
      <dl className="facts" aria-label="Selected deals by stage">
        {STAGES.filter((s) => sum.byStage[s.id].count > 0).map((s) => (
          <div key={s.id} className="perf-row"><dt>{s.label}</dt><dd>{num(sum.byStage[s.id].count)} · {inr(sum.byStage[s.id].value)}</dd></div>
        ))}
      </dl>
      <h3>Move all to</h3>
      <div className="stage-buttons" role="group" aria-label="Move selected deals to stage">
        {STAGES.map((s) => (
          <button key={s.id} className="btn small" onMouseDown={(e) => e.preventDefault()} onClick={() => app.moveTo(s.id)}>{s.label}</button>
        ))}
      </div>
      <p><button className="btn small" onMouseDown={(e) => e.preventDefault()} onClick={() => app.clearSelection()}>Clear selection (Esc)</button></p>
    </>
  )
}

/** Always visible. Selection summary when deals are selected, else the focused deal, else an empty state. */
export function DetailPanel() {
  const hasSel = useApp((a) => a.selectedCount() > 0)
  const hasRow = useApp((a) => a.activeId !== null && a.getRow(a.activeId) !== undefined)
  return (
    <aside className="detail" aria-label="Deal details">
      {hasSel ? <SelectionDetail /> : hasRow ? <DealDetail /> : (
        <div className="detail-empty" role="status">
          <h2>No deal to show</h2>
          <p className="muted">This list is empty. Change the filters, or press N to create a deal.</p>
        </div>
      )}
    </aside>
  )
}
