import { useEffect } from 'react'
import type { PipelineApp } from '../state/store'

/** Input types where letters are text. Checkboxes, radios, buttons and sliders are NOT text entry. */
const TEXT_INPUT_TYPES = new Set(['text', 'search', 'number', 'email', 'url', 'tel', 'password', 'date', 'datetime-local', 'month', 'time', 'week'])

/** Only real text-entry controls count as "typing": they own the letter keys. */
export function isTextEntry(el: Element | null): boolean {
  const c = el?.closest?.('input, textarea, select, [contenteditable]') as HTMLElement | null
  if (!c) return false
  if (c.tagName === 'INPUT') return TEXT_INPUT_TYPES.has(((c as HTMLInputElement).type || 'text').toLowerCase())
  if (c.tagName === 'TEXTAREA' || c.tagName === 'SELECT') return true
  const ce = c.getAttribute('contenteditable')
  return ce !== null && ce.toLowerCase() !== 'false'
}

/** Controls that turn a Space key press into a native click/toggle; our handler must not also act on it. */
const NATIVE_SPACE = 'button, a[href], [role="tab"], input[type="checkbox"], input[type="radio"], summary'

export function modalOpen(app: PipelineApp): boolean {
  const u = app.ui
  return u.pickerOpen || u.newDealOpen || app.confirm !== null
}

/**
 * Global keyboard handling. The complete map (see keymap.ts):
 *   arrows / WASD   move (W S rows; A D, or ← →, switch between the stage rail and the table)
 *   Space           select the row (table) / apply the stage (rail)
 *   Shift+↑↓        extend the selection        L / J  next / previous stage     K  stage picker
 *   N               new deal                    Esc    clear                     Ctrl/⌘ Z  undo
 * Actions use the selection if there is one, else the focused row, in either zone. Letters do nothing while typing in a
 * text field or while a dialog owns the keyboard. The active zone and the focused row are app state: nothing here
 * reads document.activeElement to decide what a key means (only whether a native control should keep Space/arrows).
 */
export function useKeyboard(app: PipelineApp): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // A dialog that already handled this key (and may have closed itself doing so) owns it. Without this, the
      // Space that confirms the stage picker would be seen here after the picker is gone and toggle a row.
      if (e.defaultPrevented) return
      const t = e.target as HTMLElement | null
      const typing = isTextEntry(t)
      const mod = e.ctrlKey || e.metaKey

      if (modalOpen(app)) return // dialogs handle their own keys (Esc, arrows, Enter)
      if (typing) {
        if (e.key === 'Escape') {
          e.preventDefault()
          t!.blur()
          app.setUi({ zone: 'table', gridFocus: app.ui.gridFocus + 1 }) // Esc leaves the field; WASD drives the table again
        }
        return // native editing (including Ctrl+Z) wins
      }
      if (mod && !e.altKey && e.key.toLowerCase() === 'z' && !e.shiftKey) {
        e.preventDefault()
        app.undo()
        return
      }
      if (mod || e.altKey) return
      // A focused button/checkbox keeps Space for itself (native click/toggle): never both it and us.
      if (t?.closest(NATIVE_SPACE) && e.key === ' ') return
      // A focused slider keeps its arrow keys.
      if (t?.closest('input[type="range"]') && e.key.startsWith('Arrow')) return

      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key
      const inRail = app.ui.zone === 'rail'
      const act = (fn: () => void) => {
        e.preventDefault()
        fn()
      }
      switch (key) {
        case 'ArrowUp': case 'w': return act(() => (inRail ? app.moveRail(-1) : app.moveCursor(-1, e.shiftKey)))
        case 'ArrowDown': case 's': return act(() => (inRail ? app.moveRail(1) : app.moveCursor(1, e.shiftKey)))
        case 'ArrowLeft': case 'a': return act(() => !inRail && app.setZone('rail'))
        case 'ArrowRight': case 'd': return act(() => inRail && app.setZone('table'))
        case ' ': return act(() => (inRail ? app.activateRail() : app.toggleActiveSelected()))
        case 'n': return act(() => app.setUi({ newDealOpen: true }))
        case 'Escape': {
          // Focus is stranded on a control in a panel (a slider, a Tab-focused button): Esc hands the keyboard back.
          const ae = document.activeElement
          if (ae && ae !== document.body && !ae.closest('[role="grid"]')) {
            app.setUi({ gridFocus: app.ui.gridFocus + 1 })
            return
          }
          if (app.ui.trayOpen) app.setUi({ trayOpen: false })
          else if (app.selectedCount() > 0) app.clearSelection()
          else if (app.ui.devOpen) app.setUi({ devOpen: false })
          return
        }
      }
      // Stage actions act on the selection / focused row whichever zone the arrows are in.
      const hasTarget = app.activeId !== null || app.selectedCount() > 0
      if (key === 'l') act(() => hasTarget && app.moveRelative(1))
      else if (key === 'j') act(() => hasTarget && app.moveRelative(-1))
      else if (key === 'k') act(() => hasTarget && app.setUi({ pickerOpen: true }))
    }
    // The key-up of a key a dialog consumed must not reach whatever gets focus when the dialog closes.
    const onKeyUp = (e: KeyboardEvent) => {
      if (app.swallowKeyUp !== e.key) return
      app.swallowKeyUp = null
      e.preventDefault()
      e.stopPropagation()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('keyup', onKeyUp, true)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('keyup', onKeyUp, true)
    }
  }, [app])
}
