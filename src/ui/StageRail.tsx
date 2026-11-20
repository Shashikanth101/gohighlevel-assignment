import { STAGES } from '../domain/stages'
import { useApp, useAppInstance } from '../state/hooks'
import { inr, num } from './format'

export function StageRail() {
  const app = useAppInstance()
  const counts = useApp((a) => a.counts)
  const stage = useApp((a) => a.filter.stage)
  const view = useApp((a) => a.filter.view)
  const scope = view === 'all' || view === 'failed' ? counts.all : counts.mine
  const total = STAGES.reduce((n, s) => n + scope[s.id].count, 0)
  const totalValue = STAGES.reduce((n, s) => n + scope[s.id].value, 0)
  return (
    <nav className="rail" aria-label="Stages">
      <div className="rail-title">{view === 'all' || view === 'failed' ? 'All deals' : 'My deals'}</div>
      <button className={`stage ${stage === null ? 'on' : ''}`} aria-pressed={stage === null} onClick={() => app.setStageFilter(null)}>
        <span className="stage-name">All stages</span>
        <span className="stage-count">{num(total)}</span>
        <span className="stage-value">{inr(totalValue)}</span>
      </button>
      {STAGES.map((s) => (
        <button key={s.id} className={`stage ${stage === s.id ? 'on' : ''}`} aria-pressed={stage === s.id} onClick={() => app.setStageFilter(s.id)} title={`Filter: ${s.label}. Press ${s.key} to move the focused deal here.`}>
          <span className="stage-name"><kbd>{s.key}</kbd> {s.label}</span>
          <span className="stage-count">{num(scope[s.id].count)}</span>
          <span className="stage-value">{inr(scope[s.id].value)}</span>
        </button>
      ))}
      <p className="rail-note">Counts update live, including teammate changes. They never move rows.</p>
    </nav>
  )
}
