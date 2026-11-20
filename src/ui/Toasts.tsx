import { useApp, useAppInstance } from '../state/hooks'

export function Toasts() {
  const app = useAppInstance()
  const toasts = useApp((a) => a.toasts)
  const assertive = useApp((a) => a.liveAssertive)
  const polite = useApp((a) => a.livePolite)
  return (
    <>
      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            <span>{t.message}</span>
            {t.action && (
              <button className="mini" onClick={() => { t.action!.run(); app.dismissToast(t.id) }}>
                {t.action.label}
              </button>
            )}
            <button className="x" aria-label="Dismiss" onClick={() => app.dismissToast(t.id)}>×</button>
          </div>
        ))}
      </div>
      {/* Screen-reader channels: failures interrupt, everything else waits. */}
      <div className="sr-only" aria-live="assertive" aria-atomic="true">{assertive}</div>
      <div className="sr-only" aria-live="polite" aria-atomic="true">{polite}</div>
    </>
  )
}
