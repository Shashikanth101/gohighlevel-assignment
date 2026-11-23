import { useEffect, useRef, useState, type ReactNode } from 'react'
import { validateNewDeal } from '../domain/newDeal'
import { STAGES } from '../domain/stages'
import { useApp, useAppInstance } from '../state/hooks'

export function Modal({ label, onClose, children, wide }: { label: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const box = useRef<HTMLDivElement>(null)
  const prev = useRef<Element | null>(null)
  useEffect(() => {
    prev.current = document.activeElement
    const target = box.current?.querySelector<HTMLElement>('[data-autofocus]') ?? box.current
    target?.focus()
    return () => {
      // Hand focus back to the grid so the keyboard keeps working (not to the button that opened us: Space would click it).
      const el = (document.querySelector('[role="grid"]') ?? prev.current) as HTMLElement | null
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
  // Closing hands focus back to the table, whatever had it when the picker opened.
  const close = () => app.setUi({ pickerOpen: false, gridFocus: app.ui.gridFocus + 1 })
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
          const k = e.key.toLowerCase()
          const own = k === 'arrowdown' || k === 's' || k === 'arrowup' || k === 'w' || k === 'enter' || k === ' '
          if (!own) return
          // These keys belong to the picker: nothing else (the table's Space handler!) may see them.
          e.preventDefault()
          e.stopPropagation()
          if (k === 'arrowdown' || k === 's') setI((x) => Math.min(STAGES.length - 1, x + 1))
          else if (k === 'arrowup' || k === 'w') setI((x) => Math.max(0, x - 1))
          else {
            app.swallowKeyUp = e.key
            choose(i)
          }
        }}
      >
        <h2>Move {n > 0 ? `${n.toLocaleString('en-IN')} selected deals` : 'focused deal'} to…</h2>
        <ul role="listbox" aria-label="Stages" aria-activedescendant={`pick-${i}`}>
          {STAGES.map((s, idx) => (
            <li key={s.id} id={`pick-${idx}`} role="option" aria-selected={idx === i} className={idx === i ? 'on' : ''} onClick={() => choose(idx)}>
              {s.label}
            </li>
          ))}
        </ul>
        <p className="muted">↑↓ (or W S) then Enter or Space. Esc to cancel.</p>
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

export function NewDealDialog() {
  const app = useAppInstance()
  const [name, setName] = useState('')
  const [value, setValue] = useState('')
  const [licences, setLicences] = useState('1')
  const [error, setError] = useState('')
  const close = () => app.setUi({ newDealOpen: false })
  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    const input = { name, valueInr: Number(value.replace(/[, ₹]/g, '')), licences: Number(licences) }
    const bad = validateNewDeal(input)
    if (bad) return setError(bad)
    close()
    app.createDeal(input)
  }
  return (
    <Modal label="New deal" onClose={close}>
      <form onSubmit={submit} className="new-deal">
        <h2>New deal</h2>
        <label>Deal name
          <input data-autofocus value={name} onChange={(e) => { setName(e.target.value); setError('') }} placeholder="Acme Logistics Pvt Ltd" />
        </label>
        <label>Value (₹)
          <input value={value} inputMode="numeric" onChange={(e) => { setValue(e.target.value); setError('') }} placeholder="500000" />
        </label>
        <label>Licences
          <input value={licences} inputMode="numeric" onChange={(e) => { setLicences(e.target.value); setError('') }} />
        </label>
        <p className="muted">Starts in New Lead, owned by you, contact by tomorrow.</p>
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="modal-actions">
          <button type="button" className="btn" onClick={close}>Cancel</button>
          <button type="submit" className="btn primary">Create deal</button>
        </div>
      </form>
    </Modal>
  )
}
