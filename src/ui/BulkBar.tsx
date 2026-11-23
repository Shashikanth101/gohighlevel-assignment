import { STAGES } from '../domain/stages'
import { useApp, useAppInstance } from '../state/hooks'
import { num } from './format'

export function BulkBar() {
  const app = useAppInstance()
  const count = useApp((a) => a.selectedCount())
  const kind = useApp((a) => a.selection.kind)
  const viewLen = useApp((a) => a.view.ids.length)
  const matching = useApp((a) => a.selMatching)
  if (count === 0) return null
  const allInView = kind === 'ids' && count === viewLen
  return (
    <section className="bulk" aria-label="Bulk actions">
      <div className="bulk-main">
        <strong>{num(count)} selected</strong>
        {kind === 'filter' && <span className="muted">everything matching this filter{app.selection.kind === 'filter' && app.selection.excluded.size ? `, except ${num(app.selection.excluded.size)}` : ''}</span>}
        {allInView && matching >= count && (
          <span className="banner">
            All {num(viewLen)} in this view are selected.{' '}
            <button className="link" onClick={() => app.selectAllMatching()}>Select all {num(matching)} matching</button>
          </span>
        )}
        <span className="spacer" />
        <button className="btn small" onClick={() => app.clearSelection()}>Clear (Esc)</button>
      </div>
      <div className="bulk-main">
        <button className="btn small primary" onMouseDown={(e) => e.preventDefault()} onClick={() => app.setUi({ pickerOpen: true })}>Move to… <kbd>K</kbd></button>
        {STAGES.map((s) => (
          <button key={s.id} className="btn small" onMouseDown={(e) => e.preventDefault()} onClick={() => app.moveTo(s.id)}>
            {s.label}
          </button>
        ))}
      </div>
    </section>
  )
}
