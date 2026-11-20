import { useApp, useAppInstance } from '../state/hooks'
import type { Job } from '../sync/bulk'
import { num } from './format'

function JobRow({ job }: { job: Job }) {
  const app = useAppInstance()
  const finished = job.done + job.failed + job.dropped
  const running = job.status === 'running' || job.status === 'cancelling'
  const statusText =
    job.status === 'cancelling' ? 'Cancelling…' :
    job.status === 'cancelled' ? 'Cancelled' :
    job.status === 'running' ? 'Running' :
    job.failed > 0 ? `Finished with ${num(job.failed)} not saved` : 'Done'
  return (
    <li className={`job ${job.failed ? 'has-failed' : ''}`}>
      <div className="job-head">
        <strong>{job.label}</strong>
        <span className="muted"> {statusText}{job.waiting > 0 ? ` · ${num(job.waiting)} waiting on earlier edits` : ''}</span>
      </div>
      <progress max={job.total} value={finished} aria-label={`${job.label}: ${finished} of ${job.total}`} />
      <div className="job-stats">
        <span>{num(job.done)} saved</span>
        {job.failed > 0 && <span className="bad-text">{num(job.failed)} failed</span>}
        {job.dropped > 0 && <span>{num(job.dropped)} not sent</span>}
        <span className="muted">of {num(job.total)}</span>
        <span className="spacer" />
        {running && <button className="mini" onClick={() => app.runner.cancel(job.id)} disabled={job.status === 'cancelling'}>Cancel</button>}
        {job.failed > 0 && <button className="mini" onClick={() => app.runner.retryFailed(job.id)}>Retry failed</button>}
        {!running && !job.undone && job.kind === 'move' && job.done + job.failed > 0 && <button className="mini" onClick={() => app.undoJob(job.id)}>Undo</button>}
        {!running && <button className="mini" onClick={() => app.runner.dismiss(job.id)} aria-label={`Dismiss ${job.label}`}>Dismiss</button>}
      </div>
    </li>
  )
}

export function JobsPanel() {
  const jobs = useApp((a) => a.jobs)
  if (!jobs.length) return null
  return (
    <section className="jobs" aria-label="Bulk jobs">
      <ul>{jobs.map((j) => <JobRow key={j.id} job={j} />)}</ul>
    </section>
  )
}
