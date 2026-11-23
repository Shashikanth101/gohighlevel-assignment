import { useEffect, useRef } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { SortKey } from '../domain/types'
import { RECENTLY_CLOSED_DAYS } from '../domain/priority'
import { stageLabel } from '../domain/stages'
import { useApp, useAppInstance } from '../state/hooks'
import { DealRow, ROW_H, rowDomId } from './DealRow'

const HEADERS: { label: string; sort?: SortKey; cls?: string }[] = [
  { label: '', cls: 'c-check' },
  { label: 'Deal', sort: 'name' },
  { label: 'Why', cls: 'c-why' },
  { label: 'Stage' },
  { label: 'Value', sort: 'value', cls: 'c-num' },
  { label: 'Lic.', cls: 'c-num c-lic' },
  { label: 'Owner', cls: 'c-owner' },
  { label: 'Next step' },
  { label: 'Close', sort: 'close', cls: 'c-close' },
  { label: 'Sync' },
]

export function DealGrid() {
  const app = useAppInstance()
  const ids = useApp((a) => a.view.ids)
  const activeId = useApp((a) => a.activeId)
  const sort = useApp((a) => a.sort)
  const gridFocus = useApp((a) => a.ui.gridFocus)
  const phase = useApp((a) => a.phase)
  const allPicked = useApp((a) => a.view.ids.length > 0 && a.selection.kind === 'ids' && a.selection.ids.size === a.view.ids.length)
  const zoneOn = useApp((a) => a.ui.zone === 'table')
  const view = useApp((a) => a.filter.view)
  const scroller = useRef<HTMLDivElement>(null)

  const virt = useVirtualizer({
    count: ids.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => ROW_H,
    overscan: 12,
    paddingStart: 0,
  })

  // Keep the focused row visible (and in the DOM so aria-activedescendant resolves).
  useEffect(() => {
    if (activeId === null) return
    const i = ids.indexOf(activeId)
    if (i >= 0) virt.scrollToIndex(i, { align: 'auto' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, ids])

  useEffect(() => {
    if (phase === 'ready') scroller.current?.focus({ preventScroll: true })
  }, [gridFocus, phase])

  const items = virt.getVirtualItems()
  return (
    <div
      ref={scroller}
      className={`grid-scroll ${zoneOn ? 'zone-on' : ''} ${view === 'today' ? 'show-why' : ''} ${view === 'today' || view === 'mine' ? 'hide-owner' : ''}`}
      role="grid"
      tabIndex={0}
      aria-label="Deals"
      aria-rowcount={ids.length + 1}
      aria-colcount={10}
      aria-multiselectable="true"
      aria-activedescendant={activeId !== null ? rowDomId(activeId) : undefined}
    >
      <div role="row" aria-rowindex={1} className="row head">
        {HEADERS.map((h, i) => (
          <div key={i} role="columnheader" className={h.cls} aria-sort={h.sort && sort.key === h.sort ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}>
            {i === 0 ? (
              <input type="checkbox" tabIndex={-1} checked={allPicked} aria-label="Select all in this view" onChange={() => (allPicked ? app.clearSelection() : app.selectAllInView())} />
            ) : h.sort ? (
              <button className="sort" tabIndex={-1} onClick={() => app.setSort(h.sort!)}>
                {h.label}
                {sort.key === h.sort ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : ''}
              </button>
            ) : (
              h.label
            )}
          </div>
        ))}
      </div>
      <div className="grid-body" style={{ height: virt.getTotalSize() }}>
        {items.map((v) => (
          <DealRow key={ids[v.index]} id={ids[v.index]!} index={v.index} />
        ))}
      </div>
      {ids.length === 0 && phase === 'ready' && <Empty />}
    </div>
  )
}

/** Says why the list is empty and offers the one click that most likely fixes it. */
function Empty() {
  const app = useAppInstance()
  const { view, stage, query } = useApp((a) => a.filter)
  const counts = useApp((a) => a.counts)
  const st = stage ? stageLabel(stage) : ''
  let why: string
  let fix: { label: string; run: () => void }
  if (view === 'failed') {
    why = 'Nothing failed. Every change you made is saved.'
    fix = { label: 'Go to My deals', run: () => app.setView('mine') }
  } else if (query) {
    why = stage ? `No ${st} deals match “${query}”.` : `No deals match “${query}”.`
    fix = { label: 'Clear search', run: () => app.setFilter({ query: '' }) }
  } else if (stage && view === 'today') {
    why = stage === 'won' || stage === 'lost' ? `Nothing was closed in the last ${RECENTLY_CLOSED_DAYS} days.` : `No ${st} deal needs your attention today.`
    fix = { label: `Show all ${st} deals`, run: () => app.setFilter({ view: 'mine' }) }
  } else if (stage) {
    const others = counts.all[stage].count
    if (view !== 'all' && others > 0) {
      why = `You don’t own any ${st} deals. Your team has ${others.toLocaleString('en-IN')}.`
      fix = { label: `Show all ${st} deals`, run: () => app.setFilter({ view: 'all' }) }
    } else {
      why = `There are no ${st} deals.`
      fix = { label: 'Show all stages', run: () => app.setFilter({ stage: null }) }
    }
  } else if (view === 'today') {
    why = 'Nothing needs your attention today: no overdue follow-ups, stuck, high-value or closing-soon deals, and nothing closed this week.'
    fix = { label: 'Show all my deals', run: () => app.setView('mine') }
  } else {
    why = view === 'mine' ? 'You don’t own any deals yet.' : 'There are no deals yet.'
    fix = { label: '+ New deal', run: () => app.setUi({ newDealOpen: true }) }
  }
  return (
    <div className="empty" role="status">
      <p>{why}</p>
      <button className="btn" onMouseDown={(e) => e.preventDefault()} onClick={fix.run}>{fix.label}</button>
    </div>
  )
}
