import { DAY } from '../domain/priority'

export function inr(v: number): string {
  if (v >= 1e7) return `₹${(v / 1e7).toFixed(2)} Cr`
  if (v >= 1e5) return `₹${(v / 1e5).toFixed(1)} L`
  return `₹${v.toLocaleString('en-IN')}`
}
export const num = (n: number): string => n.toLocaleString('en-IN')

/** "in 3d" / "2d ago" / "today". */
export function rel(ts: number | null, now: number): string {
  if (ts === null) return '—'
  const d = Math.round((ts - now) / DAY)
  return d === 0 ? 'today' : d > 0 ? `in ${d}d` : `${-d}d ago`
}
