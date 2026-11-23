import type { Reason } from '../domain/priority'

/**
 * Why a deal is in Today, most important first (the order comes from `priority()`).
 * Table: `max` chips in their compact form, then "+N" (tooltip lists every reason). Detail panel: all, full text.
 * Chips never wrap.
 */
export function Chips({ reasons, max }: { reasons: Reason[]; max?: number }) {
  const shown = max === undefined ? reasons : reasons.slice(0, max)
  const rest = reasons.slice(shown.length)
  return (
    <span className={`chips ${max === undefined ? 'full' : ''}`}>
      {shown.map((r) => (
        <span key={r.kind} className={`chip chip-${r.kind}`} title={r.label}>{max === undefined ? r.label : r.short}</span>
      ))}
      {rest.length > 0 && <span className="chip chip-more" title={reasons.map((r) => r.label).join('\n')}>+{rest.length}</span>}
    </span>
  )
}
