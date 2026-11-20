import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeEnv, settle, NOW, type Env } from './helpers'
import { BulkRunner } from '../src/sync/bulk'
import type { EngineEvent } from '../src/sync/engine'

let env: Env
let runner: BulkRunner
let events: EngineEvent[]
const ids = (n: number) => env.deals.slice(0, n).map((d) => d.id)

beforeEach(async () => {
  vi.useFakeTimers()
  env = await makeEnv({ size: 1600 })
  runner = new BulkRunner({ api: env.server, engine: env.engine, now: () => NOW })
  events = []
  env.engine.subscribe((e) => events.push(e))
})
afterEach(() => vi.useRealTimers())

describe('bulk jobs', () => {
  it('applies the optimistic overlay for every id in ONE engine update, then confirms in chunks', async () => {
    const target = ids(1200)
    const before = events.length
    const job = runner.start('Move 1,200 to Lost', [{ patch: { stage: 'lost' }, ids: target }])
    const applyEvents = events.slice(before)
    expect(applyEvents[0]!.touched).toHaveLength(1200) // single batched update
    expect(target.every((id) => env.engine.effective(id)!.stage === 'lost')).toBe(true)
    expect(env.engine.server.get(target[0]!)!.stage).not.toBe('lost') // still unconfirmed
    expect(job.total).toBe(1200)
    await settle(0)
    await settle(0)
    const j = runner.get(job.id)!
    expect(j).toMatchObject({ done: 1200, failed: 0, status: 'done' })
    expect(env.engine.overlay.size).toBe(0)
    expect(target.every((id) => env.server.peek(id)!.stage === 'lost')).toBe(true)
  })

  it('uses chunks of at most 500 with at most 2 in flight', async () => {
    const spy = vi.spyOn(env.server, 'bulkUpdate')
    runner.start('x', [{ patch: { stage: 'won' }, ids: ids(1500) }])
    expect(spy).toHaveBeenCalledTimes(2) // concurrency 2
    expect(spy.mock.calls.map((c) => c[0].ids.length)).toEqual([500, 500])
    await settle(0)
    await settle(0)
    expect(spy.mock.calls.map((c) => c[0].ids.length)).toEqual([500, 500, 500])
  })

  it('marks only the failed ids failed, keeps the rest, and Retry failed finishes the job', async () => {
    env.settings.set({ bulkItemFailureRate: 0.2 })
    const job = runner.start('Move', [{ patch: { stage: 'lost' }, ids: ids(500) }])
    await settle(0)
    const mid = { ...runner.get(job.id)! }
    expect(mid.failed).toBeGreaterThan(0)
    expect(mid.failed).toBeLessThan(500)
    expect(mid.done + mid.failed).toBe(500)
    expect(mid.status).toBe('done')
    expect(env.engine.problems.size).toBe(mid.failed)
    // failed rows still show the intended value (no silent rollback)
    const f = [...env.engine.problems][0]!
    expect(env.engine.effective(f)!.stage).toBe('lost')

    env.settings.set({ bulkItemFailureRate: 0 })
    expect(runner.retryFailed(job.id)).toBe(mid.failed)
    await settle(0)
    await settle(0)
    expect(runner.get(job.id)).toMatchObject({ done: 500, failed: 0, status: 'done' })
    expect(env.engine.overlay.size).toBe(0)
  })

  it('a chunk that keeps failing is retried twice (same key) and then fails all of its ids', async () => {
    env.server.failNext(3, 'rejected')
    const spy = vi.spyOn(env.server, 'bulkUpdate')
    const job = runner.start('Move', [{ patch: { stage: 'lost' }, ids: ids(300) }])
    await settle(0)
    expect(spy).toHaveBeenCalledTimes(1)
    await settle(400)
    await settle(1200)
    expect(spy).toHaveBeenCalledTimes(3)
    expect(new Set(spy.mock.calls.map((c) => c[0].idempotencyKey)).size).toBe(1)
    expect(runner.get(job.id)).toMatchObject({ done: 0, failed: 300, status: 'done' })
    runner.retryFailed(job.id)
    await settle(0)
    expect(runner.get(job.id)).toMatchObject({ done: 300, failed: 0 })
  })

  it('a lost-response chunk does not double-apply when retried', async () => {
    env.server.failNext(1, 'lost')
    const job = runner.start('Move', [{ patch: { stage: 'lost' }, ids: ids(100) }])
    await settle(0)
    const applied = env.server.stats.applied
    expect(applied).toBe(100) // applied once, response lost
    await settle(400)
    expect(env.server.stats.applied).toBe(100) // retry replayed the stored result
    expect(runner.get(job.id)).toMatchObject({ done: 100, failed: 0 })
  })

  it('cancel stops unsent chunks, lets in-flight ones finish, and reverts the unsent optimistic rows', async () => {
    const target = ids(1500)
    const job = runner.start('Move', [{ patch: { stage: 'lost' }, ids: target }])
    runner.cancel(job.id)
    expect(runner.get(job.id)!.status).toBe('cancelling')
    await settle(0)
    await settle(0)
    const j = runner.get(job.id)!
    expect(j.status).toBe('cancelled')
    expect(j.done).toBe(1000)
    expect(j.dropped).toBe(500)
    for (const id of target.slice(1000)) expect(env.engine.effective(id)!.stage).toBe(env.deals.find((d) => d.id === id)!.stage)
    for (const id of target.slice(0, 1000)) expect(env.server.peek(id)!.stage).toBe('lost')
    expect(env.engine.overlay.size).toBe(0)
  })

  it('undo reverts the completed rows through a new job (per-row previous values)', async () => {
    const target = ids(600)
    const originals = new Map(target.map((id) => [id, env.deals.find((d) => d.id === id)!.stage]))
    const job = runner.start('Move', [{ patch: { stage: 'lost' }, ids: target }])
    await settle(0)
    await settle(0)
    const undoJob = runner.undo(job.id)!
    expect(undoJob.kind).toBe('undo')
    expect(target.every((id) => env.engine.effective(id)!.stage === originals.get(id))).toBe(true) // optimistic
    await settle(0)
    await settle(0)
    expect(runner.get(undoJob.id)).toMatchObject({ done: 600, status: 'done' })
    for (const id of target) expect(env.server.peek(id)!.stage).toBe(originals.get(id))
    expect(runner.get(job.id)!.undone).toBe(true)
    expect(runner.undo(job.id)).toBeNull() // only once
  })

  it('a bulk write waits behind an in-flight single edit to the same deal (order preserved)', async () => {
    const id = env.deals[0]!.id
    env.engine.edit(id, { valueInr: 111_000 }) // in flight
    const job = runner.start('Move', [{ patch: { stage: 'lost' }, ids: [id] }])
    expect(runner.get(job.id)!.status).toBe('done') // nothing could be sent yet...
    expect(runner.get(job.id)!.waiting).toBe(1) // ...it is parked
    await settle(0)
    await settle(0)
    expect(runner.get(job.id)).toMatchObject({ done: 1, waiting: 0 })
    expect(env.server.peek(id)).toMatchObject({ valueInr: 111_000, stage: 'lost', version: env.deals[0]!.version + 2 })
  })
})
