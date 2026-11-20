export interface Settings {
  latencyMin: number
  latencyMax: number
  /** 0..1 chance a mutating request fails. */
  failureRate: number
  /** Share of failures where the write WAS applied but the response was lost. */
  lostResponseShare: number
  /** Per-id failure chance inside an otherwise successful bulk request. */
  bulkItemFailureRate: number
  /** Teammate changes per minute (0 = off). */
  teammateRate: number
  offline: boolean
  /** How often the client polls for teammate changes. */
  pollMs: number
}

export const DEFAULT_SETTINGS: Settings = {
  latencyMin: 300,
  latencyMax: 1500,
  failureRate: 0.1,
  lostResponseShare: 0.3,
  bulkItemFailureRate: 0.004,
  teammateRate: 12,
  offline: false,
  pollMs: 2000,
}

type Listener = (s: Settings) => void

/** Live, observable settings shared by the fake server and the Dev Panel. */
export class SettingsStore {
  private value: Settings
  private listeners = new Set<Listener>()
  constructor(initial: Partial<Settings> = {}) {
    this.value = { ...DEFAULT_SETTINGS, ...initial }
  }
  get(): Settings {
    return this.value
  }
  set(patch: Partial<Settings>): void {
    this.value = { ...this.value, ...patch }
    for (const l of this.listeners) l(this.value)
  }
  subscribe(l: Listener): () => void {
    this.listeners.add(l)
    return () => this.listeners.delete(l)
  }
}
