import { useApp, useAppInstance } from '../state/hooks'
import { num } from './format'

/** Teammate changes that would move or remove rows wait here until the user asks. */
export function UpdatesPill() {
  const app = useAppInstance()
  const count = useApp((a) => a.deferred.count)
  if (!count) return null
  return (
    <button className="pill" onClick={() => { app.applyDeferred(); app.setUi({ gridFocus: app.ui.gridFocus + 1 }) }} title="Show teammates’ updates">
      <span aria-hidden>↻</span> {num(count)} {count === 1 ? 'update' : 'updates'} from teammates · <u>Show</u>
    </button>
  )
}
