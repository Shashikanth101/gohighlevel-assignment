import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeEnv, settle, type Env } from './helpers'
import type { EngineEvent } from '../src/sync/engine'

let env: Env
let events: EngineEvent[]
beforeEach(async () => {
  vi.useFakeTimers()
  env = await makeEnv()
  events = []
  env.engine.subscribe((e) => events.push(e))
})
afterEach(() => vi.useRealTimers())

const pickDeal = (stage: string) => env.deals.find((d) => d.stage === stage)!

describe('single-deal writes', () => {
  it('shows the edit optimistically, then confirms it', async () => {
    const d = pickDeal('new')
    env.engine.edit(d.id, { stage: 'contacted' })
    expect(env.engine.effective(d.id)!.stage).toBe('contacted') // optimistic, instantly
    expect(env.engine.server.get(d.id)!.stage).toBe('new') // not confirmed yet
    expect(env.engine.syncOf(d.id)!.status).toBe('saving')
    await settle()
    expect(env.engine.server.get(d.id)!.stage).toBe('contacted')
    expect(env.engine.server.get(d.id)!.version).toBe(d.version + 1)
    expect(env.engine.syncOf(d.id)).toBeUndefined()
    expect(env.engine.summary().pending).toBe(0)
    expect(events.some((e) => e.acked.includes(d.id))).toBe(true)
  })

  it('returns the inverse patch and ignores no-op edits', () => {
    const d = pickDeal('new')
    expect(env.engine.edit(d.id, { stage: 'new' })).toBeNull()
    expect(env.engine.edit(d.id, { stage: 'won' })!.inverse).toEqual({ stage: 'new' })
  })

  it('auto-retries twice (400ms, 1200ms) and then marks the deal failed', async () => {
    const d = pickDeal('new')
    env.server.failNext(3, 'rejected')
    env.engine.edit(d.id, { stage: 'lost' })
    await settle(0)
    expect(env.engine.syncOf(d.id)).toMatchObject({ status: 'saving', retrying: true, attempts: 1 })
    await settle(399)
    expect(env.engine.syncOf(d.id)!.attempts).toBe(1)
    await settle(1) // 400ms: second attempt, fails
    expect(env.engine.syncOf(d.id)).toMatchObject({ status: 'saving', attempts: 2 })
    await settle(1199)
    expect(env.engine.syncOf(d.id)!.status).toBe('saving')
    await settle(1) // 1200ms later: third attempt fails -> give up
    expect(env.engine.syncOf(d.id)).toMatchObject({ status: 'failed', retrying: false })
    expect(env.engine.problems.has(d.id)).toBe(true)
    expect(env.engine.effective(d.id)!.stage).toBe('lost') // intent is kept, never silently rolled back
    expect(events.flatMap((e) => e.newFailures).map((f) => f.id)).toContain(d.id)
    expect(env.server.peek(d.id)!.stage).toBe('new')
  })

  it('manual retry succeeds after the retries are exhausted', async () => {
    const d = pickDeal('new')
    env.server.failNext(3, 'rejected')
    env.engine.edit(d.id, { stage: 'lost' })
    await settle(2000)
    expect(env.engine.syncOf(d.id)!.status).toBe('failed')
    env.engine.retry(d.id)
    await settle(0)
    expect(env.engine.syncOf(d.id)).toBeUndefined()
    expect(env.server.peek(d.id)!.stage).toBe('lost')
  })

  it('applied-but-response-lost does not double-apply on retry', async () => {
    const d = pickDeal('new')
    env.server.failNext(1, 'lost')
    env.engine.edit(d.id, { stage: 'demo' })
    await settle(0)
    expect(env.server.peek(d.id)!.version).toBe(d.version + 1) // it DID apply
    expect(env.engine.syncOf(d.id)!.retrying).toBe(true)
    await settle(400) // retry with the same idempotency key
    expect(env.engine.syncOf(d.id)).toBeUndefined()
    expect(env.server.peek(d.id)!.version).toBe(d.version + 1) // still exactly one application
    expect(env.server.stats.applied).toBe(1)
    expect(env.engine.server.get(d.id)!.version).toBe(d.version + 1)
  })

  it('keeps writes to one deal in order and coalesces queued edits', async () => {
    const d = pickDeal('new')
    env.engine.edit(d.id, { stage: 'contacted' }) // goes in flight
    env.engine.edit(d.id, { stage: 'demo' }) // queued behind it
    env.engine.edit(d.id, { stage: 'proposal', valueInr: 123_000 }) // coalesces into the queued one
    expect(env.engine.effective(d.id)).toMatchObject({ stage: 'proposal', valueInr: 123_000 })
    expect(env.engine.overlay.get(d.id)!.writes).toHaveLength(1)
    await settle(0)
    await settle(0)
    expect(env.server.stats.applied).toBe(2) // 2 requests, not 3, and never concurrently
    expect(env.server.peek(d.id)).toMatchObject({ stage: 'proposal', valueInr: 123_000, version: d.version + 2 })
    expect(env.engine.syncOf(d.id)).toBeUndefined()
  })

  it('a failed head write blocks later writes to that deal until resolved', async () => {
    const d = pickDeal('new')
    env.server.failNext(3, 'rejected')
    env.engine.edit(d.id, { stage: 'contacted' })
    env.engine.edit(d.id, { valueInr: 999_000 })
    await settle(2000)
    expect(env.engine.syncOf(d.id)!.status).toBe('failed')
    expect(env.server.stats.applied).toBe(0)
    env.engine.retry(d.id)
    await settle(0)
    await settle(0)
    expect(env.server.peek(d.id)).toMatchObject({ stage: 'contacted', valueInr: 999_000 })
  })
})

describe('conflicts', () => {
  it('rebases silently when the teammate touched different fields', async () => {
    const d = pickDeal('new')
    env.server.interfereNext('other') // teammate edits value just before my stage move lands
    env.engine.edit(d.id, { stage: 'contacted' })
    await settle(0)
    await settle(0)
    expect(env.engine.stats.rebased).toBe(1)
    expect(env.engine.syncOf(d.id)).toBeUndefined()
    const s = env.server.peek(d.id)!
    expect(s.stage).toBe('contacted')
    expect(s.valueInr).not.toBe(d.valueInr) // the teammate's edit survived
    expect(s.version).toBe(d.version + 2)
  })

  it('surfaces a same-field conflict, and Keep mine resends on top of theirs', async () => {
    const d = pickDeal('new')
    env.server.interfereNext('same')
    env.engine.edit(d.id, { stage: 'won' })
    await settle(0)
    const sync = env.engine.syncOf(d.id)!
    expect(sync.status).toBe('conflict')
    expect(sync.theirs!.stage).not.toBe('new')
    expect(sync.theirs!.stage).not.toBe('won')
    expect(events.flatMap((e) => e.newConflicts)).toContain(d.id)
    env.engine.keepMine(d.id)
    await settle(0)
    expect(env.engine.syncOf(d.id)).toBeUndefined()
    expect(env.server.peek(d.id)!.stage).toBe('won')
  })

  it('Take theirs drops my edit and shows the teammate version', async () => {
    const d = pickDeal('new')
    env.server.interfereNext('same')
    env.engine.edit(d.id, { stage: 'won' })
    await settle(0)
    const theirs = env.engine.syncOf(d.id)!.theirs!
    env.engine.takeTheirs(d.id)
    expect(env.engine.syncOf(d.id)).toBeUndefined()
    expect(env.engine.effective(d.id)!.stage).toBe(theirs.stage)
    expect(env.server.peek(d.id)!.stage).toBe(theirs.stage)
    expect(env.engine.problems.size).toBe(0)
  })

  it('treats "server already has my value" as success, not a conflict', async () => {
    const d = pickDeal('new')
    env.engine.edit(d.id, { stage: 'won' })
    // a teammate makes the very same change before our write lands
    env.engine.applyRemote([{ seq: 1, deal: { ...d, stage: 'won', version: d.version + 1, updatedBy: 3 } }])
    await settle(0)
    await settle(0)
    expect(env.engine.syncOf(d.id)).toBeUndefined()
  })
})

describe('remote changes', () => {
  it('applies newer versions to server, ignores stale ones, and reports changed fields', () => {
    const d = pickDeal('new')
    const [a] = env.engine.applyRemote([{ seq: 1, deal: { ...d, stage: 'lost', version: d.version + 1, updatedBy: 4 } }])
    expect(a).toMatchObject({ id: d.id, fields: ['stage'], by: 4, pending: false })
    expect(env.engine.applyRemote([{ seq: 1, deal: { ...d, version: d.version + 1 } }])).toEqual([]) // stale
    expect(env.engine.effective(d.id)!.stage).toBe('lost')
  })

  it('does not disturb my pending edit', () => {
    const d = pickDeal('new')
    env.server.failNext(3, 'rejected')
    env.engine.edit(d.id, { stage: 'won' })
    env.engine.applyRemote([{ seq: 1, deal: { ...d, valueInr: 5, version: d.version + 1, updatedBy: 4 } }])
    expect(env.engine.effective(d.id)).toMatchObject({ stage: 'won', valueInr: 5 })
  })
})
