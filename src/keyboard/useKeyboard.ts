import { useEffect } from 'react'
import { STAGES } from '../domain/stages'
import type { ViewId } from '../domain/types'
import type { PipelineApp } from '../state/store'
import { actionById } from './keymap'

const G_TARGETS: Record<string, ViewId> = { t: 'today', m: 'mine', a: 'all', f: 'failed' }
const TYPING = 'input, textarea, select, [contenteditable="true"]'

export function modalOpen(app: PipelineApp): boolean {
  const u = app.ui
  return u.paletteOpen || u.helpOpen || u.pickerOpen || app.confirm !== null
}

/** Global keyboard handling. Single-key shortcuts are disabled while typing and while a dialog owns the keyboard. */
export function useKeyboard(app: PipelineApp): void {
  useEffect(() => {
    let pendingG = false
    let gTimer: ReturnType<typeof setTimeout> | undefined
    const run = (id: string) => {
      const a = actionById(id)
      if (!a.enabled || a.enabled(app)) a.run(app)
    }

    const onKey = (e: KeyboardEvent) => {
      const key = e.key
      const mod = e.ctrlKey || e.metaKey
      const t = e.target as HTMLElement | null
      const typing = !!t?.closest?.(TYPING)

      if (mod && key.toLowerCase() === 'k') {
        e.preventDefault()
        app.setUi({ paletteOpen: !app.ui.paletteOpen })
        return
      }
      if (modalOpen(app)) return // dialogs handle their own keys (Esc, arrows, Enter)

      if (typing) {
        if (key === 'Escape') {
          e.preventDefault()
          ;(t as HTMLElement).blur()
          app.setUi({ gridFocus: app.ui.gridFocus + 1 })
        }
        return
      }
      if (mod && key.toLowerCase() === 'a') {
        e.preventDefault()
        run('select.all')
        return
      }
      if (mod && key.toLowerCase() === 'z' && !e.shiftKey) {
        e.preventDefault()
        run('undo')
        return
      }
      if (mod || e.altKey) return
      // Buttons keep Space/Enter for themselves; everything else still works from them.
      if (t?.closest('button, a, [role="tab"]') && (key === ' ' || key === 'Enter')) return

      if (pendingG) {
        pendingG = false
        clearTimeout(gTimer)
        const view = G_TARGETS[key.toLowerCase()]
        if (view) {
          e.preventDefault()
          run(`view.${view}`)
          return
        }
      }

      const shift = e.shiftKey
      switch (key) {
        case 'j': case 'ArrowDown': e.preventDefault(); app.moveCursor(1, shift); return
        case 'k': case 'ArrowUp': e.preventDefault(); app.moveCursor(-1, shift); return
        case 'J': e.preventDefault(); app.moveCursor(1, true); return
        case 'K': e.preventDefault(); app.moveCursor(-1, true); return
        case 'Home': e.preventDefault(); app.moveCursorTo(0, shift); return
        case 'End': e.preventDefault(); app.moveCursorTo(app.view.ids.length - 1, shift); return
        case 'PageDown': e.preventDefault(); app.moveCursor(10, shift); return
        case 'PageUp': e.preventDefault(); app.moveCursor(-10, shift); return
        case ' ': e.preventDefault(); run('select.toggle'); return
        case 'Enter': if (app.activeId) { e.preventDefault(); run('details') } return
        case 'Escape':
          if (app.ui.trayOpen) app.setUi({ trayOpen: false })
          else if (app.ui.detailOpen) app.setUi({ detailOpen: false })
          else if (app.selectedCount() > 0) app.clearSelection()
          else if (app.ui.devOpen) app.setUi({ devOpen: false })
          return
        case '/': e.preventDefault(); run('view.search'); return
        case '?': e.preventDefault(); run('help'); return
        case 'g': case 'G':
          pendingG = true
          clearTimeout(gTimer)
          gTimer = setTimeout(() => (pendingG = false), 1200)
          return
        case 'm': case 'M': e.preventDefault(); run('move.picker'); return
        case 'z': case 'Z': e.preventDefault(); run('undo'); return
        case 'r': e.preventDefault(); run('sync.retry'); return
        case 'R': e.preventDefault(); run('sync.retryAll'); return
        case 'd': e.preventDefault(); run('sync.revert'); return
        case 'D': e.preventDefault(); run('dev'); return
        case 'u': case 'U': e.preventDefault(); run('sync.updates'); return
        case 's': case 'S': e.preventDefault(); run('view.sortCycle'); return
      }
      const stage = STAGES.find((s) => s.key === key)
      if (stage) {
        e.preventDefault()
        run(`move.${stage.id}`)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      clearTimeout(gTimer)
    }
  }, [app])
}
