/**
 * Single source of truth for actions. The key handler, the command palette and the help dialog
 * all read this list, so every shortcut is discoverable and every palette command has a key (or none).
 */
import { STAGES } from '../domain/stages'
import type { SortKey, ViewId } from '../domain/types'
import type { PipelineApp } from '../state/store'

export type ActionGroup = 'Navigate' | 'Select' | 'Move' | 'Sync' | 'View' | 'App'
export interface Action {
  id: string
  label: string
  group: ActionGroup
  /** Shown in help and the palette. */
  keys?: string
  /** Extra words the command palette matches on. */
  keywords?: string
  run: (app: PipelineApp) => void
  enabled?: (app: PipelineApp) => boolean
}

const focused = (a: PipelineApp) => (a.activeId ? a.engine.syncOf(a.activeId) : undefined)
const hasProblems = (a: PipelineApp) => a.summary.failed + a.summary.conflict > 0

const goto = (view: ViewId, label: string, key: string): Action => ({
  id: `view.${view}`, label: `Go to ${label}`, group: 'View', keys: `G then ${key}`,
  run: (a) => {
    a.setView(view)
    a.setUi({ gridFocus: a.ui.gridFocus + 1 })
  },
})
const sortBy = (key: SortKey, label: string): Action => ({
  id: `sort.${key}`, label: `Sort by ${label}`, group: 'View', run: (a) => a.setSort(key),
  enabled: (a) => key !== 'priority' || a.filter.view === 'today',
})

export const ACTIONS: Action[] = [
  goto('today', 'My Today', 'T'),
  goto('mine', 'My deals', 'M'),
  goto('all', 'All deals', 'A'),
  goto('failed', 'Failed (not saved)', 'F'),

  { id: 'move.picker', label: 'Move to stage…', group: 'Move', keys: 'M', run: (a) => a.setUi({ pickerOpen: true }), enabled: (a) => a.activeId !== null || a.selectedCount() > 0 },
  ...STAGES.map<Action>((s) => ({
    id: `move.${s.id}`, label: `Move to ${s.label}`, group: 'Move', keys: s.key, run: (a) => a.moveTo(s.id),
    enabled: (a) => a.activeId !== null || a.selectedCount() > 0,
  })),
  { id: 'undo', label: 'Undo last move', group: 'Move', keys: 'Z', run: (a) => a.undo(), enabled: (a) => a.undoDepth > 0 },

  { id: 'select.toggle', label: 'Select / unselect focused row', group: 'Select', keys: 'Space', run: (a) => a.toggleActiveSelected() },
  { id: 'select.all', label: 'Select all rows in this view', group: 'Select', keys: 'Ctrl/⌘ A', run: (a) => a.selectAllInView() },
  { id: 'select.matching', label: 'Select all matching the filter', group: 'Select', run: (a) => a.selectAllMatching(), enabled: (a) => a.view.ids.length > 0 },
  { id: 'select.clear', label: 'Clear selection', group: 'Select', keys: 'Esc', run: (a) => a.clearSelection(), enabled: (a) => a.selectedCount() > 0 },

  { id: 'sync.retry', label: 'Retry focused deal', group: 'Sync', keys: 'R', run: (a) => a.activeId && a.retry(a.activeId), enabled: (a) => focused(a)?.status === 'failed' },
  { id: 'sync.revert', label: 'Revert focused deal (discard unsaved change)', group: 'Sync', keys: 'D', run: (a) => a.activeId && a.revert(a.activeId), enabled: (a) => ['failed', 'conflict'].includes(focused(a)?.status ?? '') },
  { id: 'sync.mine', label: 'Conflict: keep my change', group: 'Sync', run: (a) => a.activeId && a.keepMine(a.activeId), enabled: (a) => focused(a)?.status === 'conflict' },
  { id: 'sync.theirs', label: 'Conflict: take teammate’s version', group: 'Sync', run: (a) => a.activeId && a.takeTheirs(a.activeId), enabled: (a) => focused(a)?.status === 'conflict' },
  { id: 'sync.retryAll', label: 'Retry all unsaved changes', group: 'Sync', keys: 'Shift R', run: (a) => a.retryAll(), enabled: (a) => a.summary.failed > 0 },
  { id: 'sync.discardAll', label: 'Discard all unsaved changes', group: 'Sync', run: (a) => a.discardAll(), enabled: hasProblems },
  { id: 'sync.tray', label: 'Open sync tray', group: 'Sync', run: (a) => a.setUi({ trayOpen: !a.ui.trayOpen }) },
  { id: 'sync.updates', label: 'Show teammate updates', group: 'Sync', keys: 'U', run: (a) => a.applyDeferred(), enabled: (a) => a.deferred.count > 0 },

  { id: 'view.search', label: 'Search deals', group: 'View', keys: '/', run: (a) => a.setUi({ searchFocus: a.ui.searchFocus + 1 }) },
  { id: 'view.sortCycle', label: 'Cycle sort', group: 'View', keys: 'S', run: (a) => a.setSort(nextSort(a)) },
  sortBy('priority', 'priority'), sortBy('value', 'value'), sortBy('close', 'close date'), sortBy('activity', 'last activity'), sortBy('name', 'name'),
  ...STAGES.map<Action>((s) => ({ id: `filter.${s.id}`, label: `Filter stage: ${s.label}`, group: 'View', run: (a) => a.setStageFilter(s.id) })),
  { id: 'filter.clear', label: 'Clear stage filter and search', group: 'View', run: (a) => a.setFilter({ stage: null, query: '' }), enabled: (a) => !!a.filter.stage || !!a.filter.query },

  { id: 'details', label: 'Open details for focused deal', group: 'App', keys: 'Enter', run: (a) => a.setUi({ detailOpen: true }), enabled: (a) => a.activeId !== null },
  { id: 'palette', label: 'Command palette', group: 'App', keys: 'Ctrl/⌘ K', run: (a) => a.setUi({ paletteOpen: true }) },
  { id: 'help', label: 'Keyboard shortcuts', group: 'App', keys: '?', keywords: 'help keys cheatsheet', run: (a) => a.setUi({ helpOpen: true }) },
  { id: 'dev', label: 'Toggle Dev Panel', group: 'App', keys: 'Shift D', keywords: 'settings scenarios fake api debug', run: (a) => a.setUi({ devOpen: !a.ui.devOpen }) },
]

function nextSort(a: PipelineApp): SortKey {
  const order: SortKey[] = a.filter.view === 'today' ? ['priority', 'value', 'close', 'activity', 'name'] : ['activity', 'value', 'close', 'name']
  return order[(order.indexOf(a.sort.key) + 1) % order.length]!
}

export const actionById = (id: string): Action => ACTIONS.find((x) => x.id === id)!

/** Keys with no palette entry of their own (movement), listed for the help dialog. */
export const MOVEMENT_HELP: { keys: string; label: string }[] = [
  { keys: 'J / ↓', label: 'Next row' },
  { keys: 'K / ↑', label: 'Previous row' },
  { keys: 'Shift + ↓ / ↑', label: 'Extend selection' },
  { keys: 'Home / End', label: 'First / last row' },
  { keys: 'PgUp / PgDn', label: 'Jump 10 rows' },
]
