import { vi } from 'vitest'
import { FakeServer } from '../src/api/fakeServer'
import { SettingsStore, type Settings } from '../src/api/settings'
import { SyncEngine } from '../src/sync/engine'
import type { Deal } from '../src/domain/types'

export const NOW = Date.UTC(2026, 0, 15, 9, 0, 0)

export interface Env {
  server: FakeServer
  settings: SettingsStore
  engine: SyncEngine
  deals: Deal[]
}

/** A fake server + engine with deterministic, failure-free defaults. Tests opt in to chaos. */
export async function makeEnv(opts: { size?: number; seed?: number; settings?: Partial<Settings>; instant?: boolean } = {}): Promise<Env> {
  const settings = new SettingsStore({ failureRate: 0, teammateRate: 0, bulkItemFailureRate: 0, ...opts.settings })
  const server = new FakeServer({ size: opts.size ?? 60, seed: opts.seed ?? 7, now: () => NOW, settings, instant: opts.instant ?? true })
  const engine = new SyncEngine({ api: server, now: () => NOW })
  const deals: Deal[] = []
  await server.listDeals((c) => {
    engine.loadChunk(c)
    deals.push(...c)
  })
  return { server, settings, engine, deals }
}

/** Let promise chains and timers run. */
export const settle = (ms = 0) => vi.advanceTimersByTimeAsync(ms)
