import { useSyncExternalStore } from 'react'
import { useApp, useAppInstance } from '../state/hooks'
import { getPerf, subscribePerf } from '../perf'
import type { DevState } from '../api/fakeServer'

const NO_DEV: DevState = { armed: [], log: [] }
const noSubscribe = () => () => {}
const noDev = () => NO_DEV

function Num({ label, value, onChange, step = 1, min = 0, max }: { label: string; value: number; onChange: (v: number) => void; step?: number; min?: number; max?: number }) {
  return (
    <label className="dev-field">
      <span>{label}</span>
      <input type="number" value={value} step={step} min={min} max={max} onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  )
}

export function DevPanel() {
  const app = useAppInstance()
  const s = useApp((a) => a.settingsValue)
  const perf = useSyncExternalStore(subscribePerf, getPerf)
  const dev = useSyncExternalStore(app.server ? app.server.subscribeDev : noSubscribe, app.server ? app.server.getDev : noDev)
  useApp((a) => a.summary) // refresh stats as saves happen
  const set = app.settings.set.bind(app.settings)
  const server = app.server
  const params = new URLSearchParams(location.search)
  const note = (m: string) => app.toast({ kind: 'info', message: m })

  const reload = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const f = new FormData(e.currentTarget)
    const q = new URLSearchParams()
    q.set('size', String(f.get('size')))
    q.set('seed', String(f.get('seed')))
    location.search = q.toString()
  }

  return (
    <aside className="dev" aria-label="Dev panel">
      <div className="detail-head">
        <h2>Dev Panel</h2>
        <button className="btn small" onClick={() => app.setUi({ devOpen: false })}>Close</button>
      </div>
      <p className="muted">Fake API controls. All randomness is seeded, so a scenario replays the same way.</p>

      <h3>Scenarios</h3>
      <div className="dev-buttons">
        <button className="btn" onClick={() => { server?.armFailAll(); note('Armed: move a deal. Every attempt of that save fails, so it ends Not saved.') }}>Fail next save (all retries)</button>
        <button className="btn" onClick={() => { server?.armFailOnce(); note('Armed: move a deal. One attempt fails; the automatic retry recovers.') }}>Fail next attempt (retry recovers)</button>
        <button className="btn" onClick={() => { server?.armResponseLost(); note('Armed: move a deal. The server applies it, the response is lost, the retry must not double-apply.') }}>Response lost on next save</button>
        <button className="btn" onClick={() => { server?.interfereNext('same'); note('Armed: the next deal you save collides with a teammate edit to the same field.') }}>Teammate edits my pending deal</button>
        <button className="btn" onClick={() => { server?.interfereNext('other'); note('Armed. The next deal you save gets a teammate edit to a different field (silent rebase).') }}>…different field (silent rebase)</button>
        <button className="btn" onClick={() => { server?.burst(10, app.view.ids.slice(0, 300)); void app.pollNow(); note('10 teammate changes sent (half on rows in your list).') }}>Burst of 10 teammate changes</button>
        <button className="btn" onClick={() => { server?.goOffline(10_000); note('Offline for 10 seconds.') }}>Go offline 10s</button>
      </div>

      <div className={`dev-armed ${dev.armed.length ? 'on' : ''}`} role="status" aria-label="Armed scenarios">
        {dev.armed.length ? dev.armed.map((a) => <div key={a}>{a}</div>) : <span className="muted">Nothing armed.</span>}
        {dev.armed.length > 0 && <button className="mini" onClick={() => server?.disarm()}>Disarm</button>}
      </div>

      <h3>Write requests (last 10)</h3>
      <ol className="dev-log" aria-label="Write request log">
        {dev.log.map((r) => (
          <li key={r.n} className={`out-${r.outcome.replace(' ', '-')}`}>
            <span className="log-what" title={r.label}>{r.label}</span>
            <span className="log-try">try {r.attempt}</span>
            <strong className="log-out">{r.outcome === 'replayed' ? 'ok (already applied)' : r.outcome}</strong>
            {r.cause && <span className="muted"> · {r.cause === 'scenario' ? 'scenario' : 'random'}</span>}
          </li>
        ))}
        {dev.log.length === 0 && <li className="muted">No writes yet. Move a deal.</li>}
      </ol>

      <h3>Network</h3>
      <Num label="Latency min (ms)" value={s.latencyMin} step={50} onChange={(v) => set({ latencyMin: v, latencyMax: Math.max(v, s.latencyMax) })} />
      <Num label="Latency max (ms)" value={s.latencyMax} step={50} onChange={(v) => set({ latencyMax: Math.max(v, s.latencyMin) })} />
      <label className="dev-field">
        <span>Failure rate: {Math.round(s.failureRate * 100)}%</span>
        <input type="range" min={0} max={1} step={0.01} value={s.failureRate} onChange={(e) => set({ failureRate: Number(e.target.value) })} />
      </label>
      <label className="dev-field">
        <span>…of which response lost: {Math.round(s.lostResponseShare * 100)}%</span>
        <input type="range" min={0} max={1} step={0.05} value={s.lostResponseShare} onChange={(e) => set({ lostResponseShare: Number(e.target.value) })} />
      </label>
      <label className="dev-field">
        <span>Bulk per-deal failure: {(s.bulkItemFailureRate * 100).toFixed(1)}%</span>
        <input type="range" min={0} max={0.1} step={0.001} value={s.bulkItemFailureRate} onChange={(e) => set({ bulkItemFailureRate: Number(e.target.value) })} />
      </label>
      <label className="dev-check"><input type="checkbox" checked={s.offline} onChange={(e) => set({ offline: e.target.checked })} /> Offline</label>

      <h3>Teammates</h3>
      <Num label="Changes per minute" value={s.teammateRate} step={1} onChange={(v) => set({ teammateRate: v })} />
      <Num label="Poll every (ms)" value={s.pollMs} step={500} min={500} onChange={(v) => set({ pollMs: v })} />

      <h3>Dataset</h3>
      <form onSubmit={reload} className="dev-form">
        <label className="dev-field"><span>Size</span><input name="size" type="number" defaultValue={params.get('size') ?? 50000} min={100} max={200000} step={1000} /></label>
        <label className="dev-field"><span>Seed</span><input name="seed" type="number" defaultValue={params.get('seed') ?? 42} /></label>
        <button className="btn" type="submit">Reload with these</button>
      </form>
      <p className="muted">Also: <code>?size=</code> and <code>?seed=</code> in the URL.</p>

      <h3>Stats</h3>
      <dl className="facts">
        <dt>Writes applied on server</dt><dd>{server?.stats.applied ?? '—'}</dd>
        <dt>Rejected / response lost</dt><dd>{server ? `${server.stats.failedRejected} / ${server.stats.failedLost}` : '—'}</dd>
        <dt>Silent rebases</dt><dd>{app.engine.stats.rebased}</dd>
        <dt>Auto-retries</dt><dd>{app.engine.stats.retries}</dd>
        <dt>Teammate changes</dt><dd>{server?.stats.teammateChanges ?? '—'}</dd>
      </dl>

      <h3>Performance (last)</h3>
      <dl className="facts">
        {perf.map((p) => (
          <div key={p.name} className="perf-row"><dt>{p.name}</dt><dd>{p.ms.toFixed(1)} ms{p.detail ? <span className="muted"> {p.detail}</span> : null}</dd></div>
        ))}
      </dl>
    </aside>
  )
}
