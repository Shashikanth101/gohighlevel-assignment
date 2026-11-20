import { useEffect, useRef } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { SortKey } from '../domain/types'
import { useApp, useAppInstance } from '../state/hooks'
import { DealRow, ROW_H, rowDomId } from './DealRow'

const HEADERS: { label: string; sort?: SortKey; cls?: string }[] = [
  { label: '' },
  { label: 'Deal', sort: 'name' },
  { label: 'Stage' },
  { label: 'Value', sort: 'value', cls: 'c-num' },
  { label: 'Lic.', cls: 'c-num' },
  { label: 'Owner' },
  { label: 'Follow-up' },
  { label: 'Close', sort: 'close' },
  { label: 'Status' },
]

export function DealGrid() {
  const app = useAppInstance()
  const ids = useApp((a) => a.view.ids)
  const activeId = useApp((a) => a.activeId)
  const sort = useApp((a) => a.sort)
  const gridFocus = useApp((a) => a.ui.gridFocus)
  const phase = useApp((a) => a.phase)
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
      className="grid-scroll"
      role="grid"
      tabIndex={0}
      aria-label="Deals"
      aria-rowcount={ids.length + 1}
      aria-colcount={9}
      aria-multiselectable="true"
      aria-activedescendant={activeId !== null ? rowDomId(activeId) : undefined}
    >
      <div role="row" aria-rowindex={1} className="row head">
        {HEADERS.map((h, i) => (
          <div key={i} role="columnheader" className={h.cls} aria-sort={h.sort && sort.key === h.sort ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}>
            {h.sort ? (
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

function Empty() {
  const view = useApp((a) => a.filter.view)
  const msg =
    view === 'failed' ? 'Nothing failed. Every change you made is saved.' :
    view === 'today' ? 'Nothing needs attention today. Nice.' : 'No deals match.'
  return <p className="empty" role="status">{msg}</p>
}
