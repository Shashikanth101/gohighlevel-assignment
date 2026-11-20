import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { STAGES } from '../domain/stages'
import { ACTIONS, MOVEMENT_HELP, type Action, type ActionGroup } from '../keyboard/keymap'
import { useApp, useAppInstance } from '../state/hooks'
import type { PipelineApp } from '../state/store'

function Modal({ label, onClose, children, wide }: { label: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const box = useRef<HTMLDivElement>(null)
  const prev = useRef<Element | null>(null)
  useEffect(() => {
    prev.current = document.activeElement
    const target = box.current?.querySelector<HTMLElement>('[data-autofocus]') ?? box.current
    target?.focus()
    return () => {
      // Hand focus back to the grid so the keyboard keeps working.
      const el = prev.current as HTMLElement | null
      if (el && document.contains(el) && el.tagName !== 'BODY') el.focus()
    }
  }, [])
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={box}
        className={`modal ${wide ? 'wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            onClose()
          } else if (e.key === 'Tab') {
            const f = [...box.current!.querySelectorAll<HTMLElement>('button, input, [tabindex="0"]')].filter((x) => !x.hasAttribute('disabled'))
            if (!f.length) return
            const first = f[0]!, last = f[f.length - 1]!
            if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
            else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
          }
        }}
      >
        {children}
      </div>
    </div>
  )
}

export function StagePicker() {
  const app = useAppInstance()
  const [i, setI] = useState(() => Math.max(0, STAGES.findIndex((s) => s.id === (app.activeId ? app.engine.effective(app.activeId)?.stage : null))))
  const close = () => app.setUi({ pickerOpen: false })
  const choose = (idx: number) => {
    close()
    app.moveTo(STAGES[idx]!.id)
  }
  const n = app.selectedCount()
  return (
    <Modal label="Move to stage" onClose={close}>
      <div
        data-autofocus
        tabIndex={0}
        className="picker"
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'j') { e.preventDefault(); setI((x) => Math.min(6, x + 1)) }
          else if (e.key === 'ArrowUp' || e.key === 'k') { e.preventDefault(); setI((x) => Math.max(0, x - 1)) }
          else if (e.key === 'Enter') { e.preventDefault(); choose(i) }
          else {
            const idx = STAGES.findIndex((s) => s.key === e.key)
            if (idx >= 0) { e.preventDefault(); choose(idx) }
          }
        }}
      >
        <h2>Move {n > 0 ? `${n.toLocaleString('en-IN')} selected deals` : 'focused deal'} to…</h2>
        <ul role="listbox" aria-label="Stages" aria-activedescendant={`pick-${i}`}>
          {STAGES.map((s, idx) => (
            <li key={s.id} id={`pick-${idx}`} role="option" aria-selected={idx === i} className={idx === i ? 'on' : ''} onClick={() => choose(idx)}>
              <kbd>{s.key}</kbd> {s.label}
            </li>
          ))}
        </ul>
        <p className="muted">↑↓ then Enter, or press a number. Esc to cancel.</p>
      </div>
    </Modal>
  )
}

export function ConfirmDialog() {
  const app = useAppInstance()
  const c = useApp((a) => a.confirm)
  if (!c) return null
  return (
    <Modal label={c.title} onClose={() => app.resolveConfirm(false)}>
      <h2>{c.title}</h2>
      <ul className="confirm-lines">{c.lines.map((l) => <li key={l}>{l}</li>)}</ul>
      <div className="modal-actions">
        <button className="btn" onClick={() => app.resolveConfirm(false)}>Cancel</button>
        <button className="btn danger" data-autofocus onClick={() => app.resolveConfirm(true)}>{c.confirmLabel}</button>
      </div>
    </Modal>
  )
}

const GROUP_ORDER: ActionGroup[] = ['Navigate', 'Move', 'Select', 'View', 'Sync', 'App']

export function ShortcutsHelp() {
  const app = useAppInstance()
  const close = () => app.setUi({ helpOpen: false })
  const groups = useMemo(() => {
    const m = new Map<ActionGroup, { keys: string; label: string }[]>()
    for (const g of GROUP_ORDER) m.set(g, [])
    m.get('Navigate')!.push(...MOVEMENT_HELP)
    for (const a of ACTIONS) if (a.keys) m.get(a.group)!.push({ keys: a.keys, label: a.label })
    return [...m].filter(([, v]) => v.length)
  }, [])
  return (
    <Modal label="Keyboard shortcuts" onClose={close} wide>
      <h2>Keyboard shortcuts</h2>
      <div className="help-grid" data-autofocus tabIndex={0}>
        {groups.map(([g, items]) => (
          <section key={g}>
            <h3>{g}</h3>
            <dl>
              {items.map((it) => (
                <div key={it.keys + it.label}>
                  <dt><kbd>{it.keys}</kbd></dt>
                  <dd>{it.label}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
      <p className="muted">Single keys are off while you type in a field. Everything above is also in the command palette (Ctrl/⌘ K).</p>
      <div className="modal-actions"><button className="btn" onClick={close}>Close (Esc)</button></div>
    </Modal>
  )
}

function matchScore(label: string, q: string): number {
  const l = label.toLowerCase()
  let pos = 0
  for (const tok of q.toLowerCase().split(/\s+/).filter(Boolean)) {
    const at = l.indexOf(tok)
    if (at < 0) return -1
    pos += at
  }
  return pos
}

export function CommandPalette() {
  const app = useAppInstance()
  const [q, setQ] = useState('')
  const [i, setI] = useState(0)
  const list = useRef<HTMLUListElement>(null)
  const close = () => app.setUi({ paletteOpen: false })
  const results = useMemo<Action[]>(() => {
    const ok = ACTIONS.filter((a) => !a.enabled || a.enabled(app))
    if (!q.trim()) return ok
    return ok
      .map((a) => [a, matchScore(a.label + ' ' + a.group, q)] as const)
      .filter(([, s]) => s >= 0)
      .sort((x, y) => x[1] - y[1])
      .map(([a]) => a)
  }, [q, app])
  const sel = Math.min(i, Math.max(0, results.length - 1))
  useEffect(() => {
    list.current?.children[sel]?.scrollIntoView({ block: 'nearest' })
  }, [sel])
  const run = (a: Action | undefined) => {
    if (!a) return
    close()
    // Let the dialog unmount (restoring focus) before the action runs.
    setTimeout(() => a.run(app as PipelineApp), 0)
  }
  return (
    <Modal label="Command palette" onClose={close} wide>
      <input
        data-autofocus
        className="palette-input"
        role="combobox"
        aria-expanded="true"
        aria-controls="palette-list"
        aria-activedescendant={results[sel] ? `cmd-${results[sel]!.id}` : undefined}
        placeholder="Type a command…"
        value={q}
        onChange={(e) => { setQ(e.target.value); setI(0) }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setI(Math.min(results.length - 1, sel + 1)) }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setI(Math.max(0, sel - 1)) }
          else if (e.key === 'Enter') { e.preventDefault(); run(results[sel]) }
        }}
      />
      <ul id="palette-list" ref={list} role="listbox" className="palette-list">
        {results.map((a, idx) => (
          <li key={a.id} id={`cmd-${a.id}`} role="option" aria-selected={idx === sel} className={idx === sel ? 'on' : ''} onClick={() => run(a)} onMouseMove={() => setI(idx)}>
            <span className="muted group">{a.group}</span> {a.label}
            {a.keys && <kbd>{a.keys}</kbd>}
          </li>
        ))}
        {results.length === 0 && <li className="muted pad" role="option" aria-selected="false">No matching command</li>}
      </ul>
    </Modal>
  )
}

