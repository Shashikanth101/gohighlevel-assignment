import { memo, useMemo } from 'react'
import { whyChips } from '../domain/priority'
import { isTerminal, stageLabel } from '../domain/stages'
import { userName } from '../domain/users'
import { isSelected } from '../state/selection'
import { useApp, useAppInstance } from '../state/hooks'
import type { RowView } from '../state/store'
import { Chips } from './Chips'
import { closeCell, inr, rel } from './format'

export const ROW_H = 40
/** Dev/test hook: counts DealRow renders so we can show one change re-renders one row. */
export const rowRenders = { n: 0, ids: new Set<string>() }
export const rowDomId = (id: string) => `row-${id}`

/** One short label; the focused row's detail panel carries Retry / Revert / Keep mine / Take theirs. */
function Status({ row }: { row: RowView }) {
  switch (row.status) {
    case 'saving': return <span className="st st-saving">{row.retrying ? 'Retrying…' : 'Saving…'}</span>
    case 'queued': return <span className="st st-saving">Queued</span>
    case 'failed': return <span className="st st-failed" title={row.error}><strong>Not saved</strong></span>
    case 'conflict': return <span className="st st-conflict" title={row.error}><strong>Conflict</strong></span>
    default:
      // Synced rows show nothing. A teammate's pending change is not "synced" yet, so it still shows.
      if (row.deferredBy !== undefined) return <span className="st st-remote" title={`${userName(row.deferredBy)} edited this. It moves when you refresh the list.`}>{userName(row.deferredBy)} edited</span>
      return null
  }
}

export const DealRow = memo(function DealRow({ id, index }: { id: string; index: number }) {
  const app = useAppInstance()
  const row = useApp((a) => a.getRow(id))
  const active = useApp((a) => a.activeId === id)
  const selected = useApp((a) => isSelected(a.selection, id))
  const showReasons = useApp((a) => a.filter.view === 'today')
  const now = useApp((a) => a.view.now)
  rowRenders.n++
  rowRenders.ids.add(id)
  const deal = row?.deal
  const reasons = useMemo(() => (showReasons && deal ? whyChips(deal, now) : []), [showReasons, deal, now])
  if (!row || !deal) return null
  const closed = isTerminal(deal.stage)
  const close = closeCell(deal, now)

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
        app.setUi({ zone: 'table', gridFocus: app.ui.gridFocus + 1 })
      }}
    >
      {row.flash > 0 && <span key={row.flash} className="flash" aria-hidden />}
      <div role="gridcell" className="c-check">
        <input type="checkbox" tabIndex={-1} checked={selected} aria-label={`Select ${deal.name}`} onChange={() => { app.toggleSelected(id); app.setUi({ zone: 'table', gridFocus: app.ui.gridFocus + 1 }) }} onClick={(e) => e.stopPropagation()} />
      </div>
      <div role="gridcell" className="c-name">
        <span className="name" title={deal.name}>{deal.name}</span>
      </div>
      <div role="gridcell" className="c-why"><Chips reasons={reasons} max={2} /></div>
      <div role="gridcell" className="c-stage">{stageLabel(deal.stage)}</div>
      <div role="gridcell" className="c-num">{inr(deal.valueInr)}</div>
      <div role="gridcell" className="c-num c-lic">{deal.licences}</div>
      <div role="gridcell" className="c-owner">{userName(deal.ownerId)}</div>
      {/* Closed deals have no next step: a muted dash, never a date. */}
      <div role="gridcell" className={closed || deal.nextFollowUpAt === null ? 'dim' : deal.nextFollowUpAt < now ? 'overdue' : ''} title={closed ? undefined : deal.stage === 'new' ? 'Contact by' : 'Next follow-up'}>
        {closed ? '—' : rel(deal.nextFollowUpAt, now)}
      </div>
      <div role="gridcell" className={`c-close ${close.tone === 'muted' ? 'dim' : close.tone === 'overdue' ? 'overdue' : ''}`}>{close.text}</div>
      <div role="gridcell" className="c-status"><Status row={row} /></div>
    </div>
  )
})
