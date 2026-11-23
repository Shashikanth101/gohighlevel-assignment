import { STAGES } from '../domain/stages'
import { KEY_GROUPS } from '../keyboard/keymap'
import { useApp, useAppInstance } from '../state/hooks'
import { inr, num } from './format'

export function StageRail() {
  const app = useAppInstance()
  const counts = useApp((a) => a.counts)
  const scoped = useApp((a) => a.scoped)
  const stage = useApp((a) => a.filter.stage)
  const view = useApp((a) => a.filter.view)
  const query = useApp((a) => a.filter.query)
  const zoneOn = useApp((a) => a.ui.zone === 'rail')
  const cursor = useApp((a) => a.railIndex()) // derived from the stage filter unless W/S moved ahead of it
  // Counts describe exactly what a click would list: this view's scope, narrowed by the search if any.
  const scope = scoped ?? (view === 'all' ? counts.all : counts.mine)
  const total = STAGES.reduce((n, s) => n + scope[s.id].count, 0)
  const totalValue = STAGES.reduce((n, s) => n + scope[s.id].value, 0)
  const title = { today: 'Today', mine: 'My deals', all: 'All deals', failed: 'Failed deals' }[view]
  const pick = (run: () => void) => {
    app.setZone('rail')
    run()
    app.setUi({ gridFocus: app.ui.gridFocus + 1 })
  }
  const cls = (i: number, on: boolean, n: number) => `stage ${on ? 'on' : ''} ${n === 0 ? 'zero' : ''} ${zoneOn && cursor === i ? 'cursor' : ''}`
  return (
    <nav className={`rail ${zoneOn ? 'zone-on' : ''}`} aria-label="Stages">
      <div className="rail-stages">
      <div className="rail-title">{title}{query ? ` matching “${query}”` : ''}</div>
      <button className={cls(0, stage === null, total)} aria-pressed={stage === null} onClick={() => pick(() => app.setStageFilter(null))}>
        <span className="stage-name">All stages</span>
        <span className="stage-count">{num(total)}</span>
        <span className="stage-value">{inr(totalValue)}</span>
      </button>
      {STAGES.map((s, i) => (
        <button key={s.id} className={cls(i + 1, stage === s.id, scope[s.id].count)} aria-pressed={stage === s.id} onClick={() => pick(() => app.setStageFilter(s.id))} title={`Show ${s.label}`}>
          <span className="stage-name">{s.label}</span>
          <span className="stage-count">{num(scope[s.id].count)}</span>
          <span className="stage-value">{inr(scope[s.id].value)}</span>
        </button>
      ))}
      <p className="rail-note">Counts follow the list you are in and update live. They never move rows.</p>
      </div>
      <section className="keys" aria-label="Keyboard shortcuts">
        <div className="keys-zone">Keys act on: <strong>{zoneOn ? 'Stage list' : 'Deals table'}</strong></div>
        {KEY_GROUPS.map((g) => (
          <dl key={g.title}>
            <dt>{g.title}</dt>
            {g.keys.map((k) => (
              <dd key={k.keys}><kbd>{k.keys}</kbd> {k.label}</dd>
            ))}
          </dl>
        ))}
      </section>
    </nav>
  )
}
