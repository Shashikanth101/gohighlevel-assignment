/** The whole keyboard map. The key handler implements it, the sidebar key list renders it. Nothing else is bound. */
export const KEY_GROUPS: { title: string; keys: { keys: string; label: string }[] }[] = [
  { title: 'Move', keys: [
    { keys: '↑ ↓ / W S', label: 'up / down' },
    { keys: '← → / A D', label: 'rail ⇄ table' },
  ] },
  { title: 'Select', keys: [
    { keys: 'Space', label: 'select' },
    { keys: 'Shift+↑↓', label: 'extend' },
  ] },
  { title: 'Act', keys: [
    { keys: 'J', label: 'previous stage' },
    { keys: 'L', label: 'next stage' },
    { keys: 'K', label: 'move to…' },
    { keys: 'N', label: 'new deal' },
  ] },
  { title: 'Other', keys: [
    { keys: 'Esc', label: 'clear' },
    { keys: 'Ctrl/⌘ Z', label: 'undo' },
  ] },
]
