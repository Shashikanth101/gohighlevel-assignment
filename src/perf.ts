/** Tiny wrapper over performance.mark/measure that also remembers the latest numbers for the Dev Panel. */
export interface PerfEntry {
  name: string
  ms: number
  detail?: string
}
const latest = new Map<string, PerfEntry>()
const listeners = new Set<() => void>()
let snapshot: PerfEntry[] = []

const hasPerf = typeof performance !== 'undefined' && typeof performance.measure === 'function'

export function measure<T>(name: string, fn: () => T, detail?: () => string): T {
  const start = performance.now()
  try {
    return fn()
  } finally {
    record(name, performance.now() - start, start, detail?.())
  }
}

export function record(name: string, ms: number, start?: number, detail?: string): void {
  if (hasPerf) {
    try {
      performance.measure(`pipeline:${name}`, { start: start ?? performance.now() - ms, duration: ms, detail })
    } catch {
      /* measure options unsupported */
    }
  }
  latest.set(name, { name, ms, detail })
  snapshot = [...latest.values()]
  for (const l of listeners) l()
  if (typeof console !== 'undefined' && import.meta.env?.DEV) console.debug(`[perf] ${name}: ${ms.toFixed(1)}ms${detail ? ` (${detail})` : ''}`)
}

export const getPerf = (): PerfEntry[] => snapshot
export function subscribePerf(l: () => void): () => void {
  listeners.add(l)
  return () => listeners.delete(l)
}

/** Start a stopwatch that stops after the browser has painted the result of the current work. */
export function measureToPaint(name: string, start = performance.now()): () => void {
  return () => {
    if (typeof requestAnimationFrame !== 'function') return
    requestAnimationFrame(() => requestAnimationFrame(() => record(name, performance.now() - start, start)))
  }
}
