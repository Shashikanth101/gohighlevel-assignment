import { useEffect, useRef, useState } from 'react'
import type { ViewId } from '../domain/types'
import { useApp, useAppInstance } from '../state/hooks'
import { num } from './format'
import { SyncTray } from './SyncTray'

const VIEWS: { id: ViewId; label: string }[] = [
  { id: 'today', label: 'Today' },
  { id: 'mine', label: 'My deals' },
  { id: 'all', label: 'All deals' },
  { id: 'failed', label: 'Failed' },
]

export function Header() {
  const app = useAppInstance()
  const view = useApp((a) => a.filter.view)
  const query = useApp((a) => a.filter.query)
  const failedCount = useApp((a) => a.summary.failed + a.summary.conflict)
  const searchFocus = useApp((a) => a.ui.searchFocus)
  const online = useApp((a) => a.online)
  const input = useRef<HTMLInputElement>(null)
  const [text, setText] = useState(query)

  // The box always shows the active search. A view switch clears it, including text still waiting on the debounce.
  useEffect(() => setText(query), [query, view])
  useEffect(() => {
    if (searchFocus > 0) input.current?.focus()
  }, [searchFocus])
  // Debounce so typing stays smooth at 50k rows.
  useEffect(() => {
    if (text === query) return
    const t = setTimeout(() => app.setQuery(text.trim()), 120)
    return () => clearTimeout(t)
  }, [text, query, app])

  return (
    <header className="header">
      <h1>Sales Pipeline</h1>
      <div role="tablist" aria-label="Views" className="tabs">
        {VIEWS.map((v) => (
          <button
            key={v.id}
            role="tab"
            aria-selected={view === v.id}
            className={`tab ${view === v.id ? 'on' : ''}`}
            onClick={() => {
              app.setView(v.id)
              app.setUi({ gridFocus: app.ui.gridFocus + 1 })
            }}
          >
            {v.label}
            {v.id === 'failed' && failedCount > 0 && <span className="badge">{num(failedCount)}</span>}
          </button>
        ))}
      </div>
      <label className="search">
        <span className="sr-only">Search deals</span>
        <input
          ref={input}
          type="search"
          placeholder="Search deals…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              app.setQuery(text.trim())
              app.setUi({ zone: 'table', gridFocus: app.ui.gridFocus + 1 })
            }
          }}
        />
      </label>
      <div className="spacer" />
      <button className="btn primary" onClick={() => app.setUi({ newDealOpen: true })} title="New deal (N)">+ New deal</button>
      {!online && <span className="offline-chip" role="status">Offline</span>}
      <SyncTray />
      <button className="btn" onClick={() => app.setUi({ devOpen: !app.ui.devOpen })} aria-pressed={app.ui.devOpen}>Dev</button>
    </header>
  )
}
