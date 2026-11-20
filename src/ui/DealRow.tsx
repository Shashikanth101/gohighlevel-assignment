import { memo, useMemo } from 'react'
import { priority, type Reason } from '../domain/priority'
import { stageLabel } from '../domain/stages'
import { userName } from '../domain/users'
import { isSelected } from '../state/selection'
import { useApp, useAppInstance } from '../state/hooks'
import type { RowView } from '../state/store'
import { inr, rel } from './format'

export const ROW_H = 40
export const rowDomId = (id: string) => `row-${id}`

function Status({ row }: { row: RowView }) {
  const app = useAppInstance()
  const stop = (fn: () => void) => (e: React.MouseEvent) => {
    e.stopPropagation()
    fn()
  }
  switch (row.status) {
    case 'saving':
      return <span className="st st-saving">{row.retrying ? 'Retrying…' : 'Saving…'}</span>
    case 'queued':
      return <span className="st st-saving">Queued</span>
    case 'failed':
      return (
        <span className="st st-failed" title={row.error}>
          <strong>Not saved</strong>
          <button className="mini" onClick={stop(() => app.retry(row.id))}>Retry</button>
          <button className="mini" onClick={stop(() => app.revert(row.id))}>Revert</button>
        </span>
      )
    case 'conflict':
      return (
        <span className="st st-conflict" title={row.error}>
          <strong>Conflict</strong>
          <button className="mini" onClick={stop(() => app.keepMine(row.id))}>Keep mine</button>
          <button className="mini" onClick={stop(() => app.takeTheirs(row.id))}>Take theirs</button>
        </span>
      )
    default:
      if (row.saved) return <span className="st st-saved">✓ Saved</span>
      if (row.deferredBy !== undefined) return <span className="st st-remote" title="Moves when you refresh the list">{userName(row.deferredBy)} edited · moves on refresh</span>
      return null
  }
}

function Chips({ reasons }: { reasons: Reason[] }) {
  return (
    <span className="chips">
      {reasons.slice(0, 2).map((r) => (
        <span key={r.kind} className={`chip chip-${r.kind}`}>{r.label}</span>
      ))}
      {reasons.length > 2 && <span className="chip" title={reasons.slice(2).map((r) => r.label).join(', ')}>+{reasons.length - 2}</span>}
    </span>
  )
}

export const DealRow = memo(function DealRow({ id, index }: { id: string; index: number }) {
  const app = useAppInstance()
  const row = useApp((a) => a.getRow(id))
  const active = useApp((a) => a.activeId === id)
  const selected = useApp((a) => isSelected(a.selection, id))
  const showReasons = useApp((a) => a.filter.view === 'today')
  const now = useApp((a) => a.view.now)
  const deal = row?.deal
  const reasons = useMemo(() => (showReasons && deal ? priority(deal, now).reasons : []), [showReasons, deal, now])
  if (!row || !deal) return null

  const cls = ['row', active && 'active', selected && 'selected', row.status === 'failed' && 'failed', row.status === 'conflict' && 'conflict', row.status === 'saving' && 'saving']
    .filter(Boolean)
    .join(' ')
  return (
    <div
      id={rowDomId(id)}
      role="row"
      aria-rowindex={index + 2}
      aria-selected={selected}
      aria-label={`${deal.name}, ${stageLabel(deal.stage)}, ${inr(deal.valueInr)}${row.status !== 'synced' ? `, ${row.status}` : ''}`}
      className={cls}
      style={{ transform: `translateY(${index * ROW_H}px)`, height: ROW_H }}
      onClick={(e) => {
        if (e.shiftKey) app.selectRangeTo(id)
        else if (e.metaKey || e.ctrlKey) app.toggleSelected(id)
        else app.setActive(id)
        app.setUi({ gridFocus: app.ui.gridFocus + 1 })
      }}
      onDoubleClick={() => {
        app.setActive(id)
        app.setUi({ detailOpen: true })
      }}
    >
      {row.flash > 0 && <span key={row.flash} className="flash" aria-hidden />}
      <div role="gridcell" className="c-check">
        <input type="checkbox" tabIndex={-1} checked={selected} aria-label={`Select ${deal.name}`} onChange={() => app.toggleSelected(id)} onClick={(e) => e.stopPropagation()} />
      </div>
      <div role="gridcell" className="c-name">
        <span className="name">{deal.name}</span>
        <Chips reasons={reasons} />
      </div>
      <div role="gridcell" className="c-stage">{stageLabel(deal.stage)}</div>
      <div role="gridcell" className="c-num">{inr(deal.valueInr)}</div>
      <div role="gridcell" className="c-num">{deal.licences}</div>
      <div role="gridcell">{userName(deal.ownerId)}</div>
      <div role="gridcell" className={deal.nextFollowUpAt !== null && deal.nextFollowUpAt < now ? 'overdue' : ''}>{rel(deal.nextFollowUpAt, now)}</div>
      <div role="gridcell">{rel(deal.expectedCloseAt, now)}</div>
      <div role="gridcell" className="c-status"><Status row={row} /></div>
    </div>
  )
})
