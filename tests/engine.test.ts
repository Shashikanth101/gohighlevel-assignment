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
    expect(env.engine.edit(d.id, { stage: 'won' })!.inverse).toEqual({ stage: 'new', stageEnteredAt: d.stageEnteredAt }) // undo also restores the entry date
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

describe('creating deals', () => {
  const input = { name: '  Zeta Labs ', valueInr: 640_000, licences: 12 }

  it('shows the deal at once under a temporary id, then swaps in the server row and id', async () => {
    const before = env.server.size
    const tmp = env.engine.create(input)
    expect(tmp).toMatch(/^tmp-/)
    const d = env.engine.effective(tmp)!
    expect([d.name, d.stage, d.ownerId, d.valueInr, d.licences]).toEqual(['Zeta Labs', 'new', 0, 640_000, 12])
    expect(env.engine.syncOf(tmp)!.status).toBe('saving')
    expect(env.engine.isCreating(tmp)).toBe(true)
    expect(events[0]!.changes).toEqual([{ id: tmp, prev: undefined, next: d }])
    await settle()
    expect(env.engine.effective(tmp)).toBeUndefined()
    expect(env.engine.syncOf(tmp)).toBeUndefined()
    const ev = events.find((e) => e.replaced.length)!
    const real = ev.replaced[0]!.to
    expect(ev.replaced[0]!.from).toBe(tmp)
    expect(real).toMatch(/^D-/)
    expect(env.engine.effective(real)!.version).toBe(1)
    expect(env.server.size).toBe(before + 1)
    expect(env.engine.summary().pending).toBe(0)
    expect(ev.changes.find((c) => c.id === tmp)).toMatchObject({ next: undefined }) // counts can drop the temp row
  })

  it('cannot be edited or bulk-moved until it has a real id', () => {
    const tmp = env.engine.create(input)
    expect(env.engine.edit(tmp, { stage: 'won' })).toBeNull()
    expect(env.engine.applyBulk('j', [tmp], { stage: 'won' }).size).toBe(0)
    expect(env.engine.effective(tmp)!.stage).toBe('new')
  })

  it('retries twice, then fails visibly; Retry succeeds without creating a duplicate', async () => {
    const before = env.server.size
    env.server.failNext(3, 'rejected')
    const tmp = env.engine.create(input)
    await settle(400)
    expect(env.engine.syncOf(tmp)).toMatchObject({ status: 'saving', retrying: true })
    await settle(1200)
    expect(env.engine.syncOf(tmp)!.status).toBe('failed')
    expect(env.engine.problems.has(tmp)).toBe(true)
    expect(env.engine.summary()).toMatchObject({ failed: 1, pending: 1 })
    expect(events.some((e) => e.newFailures.some((f) => f.id === tmp))).toBe(true)
    expect(env.server.size).toBe(before)
    env.engine.retry(tmp)
    await settle()
    expect(env.engine.effective(tmp)).toBeUndefined()
    expect(env.server.size).toBe(before + 1)
    expect(env.engine.problems.size).toBe(0)
    expect(env.engine.summary().pending).toBe(0)
  })

  it('a lost response is retried with the same key: the server creates exactly one deal', async () => {
    const before = env.server.size
    env.server.failNext(1, 'lost')
    env.engine.create(input)
    await settle(400)
    await settle()
    expect(env.server.size).toBe(before + 1)
    expect(events.flatMap((e) => e.replaced)).toHaveLength(1)
    expect(env.engine.summary().pending).toBe(0)
  })

  it('Revert on a failed create removes the optimistic row', async () => {
    env.server.failNext(3, 'rejected')
    const tmp = env.engine.create(input)
    await settle(2000)
    env.engine.revert(tmp)
    expect(env.engine.effective(tmp)).toBeUndefined()
    expect(env.engine.problems.size).toBe(0)
    expect(env.engine.summary().pending).toBe(0)
    expect(events.at(-1)!.changes).toEqual([expect.objectContaining({ id: tmp, next: undefined })])
  })

  it('never duplicates the deal when the change feed also delivers it', async () => {
    const tmp = env.engine.create(input)
    const real = env.server.peek(`D-${String(env.server.size + 1).padStart(5, '0')}`)
    expect(real).toBeUndefined() // not created yet: the request is still in flight
    await settle()
    const { changes } = await env.server.changesSince(0)
    env.engine.applyRemote(changes) // idempotent: the confirmed row is already there
    expect([...env.engine.effectiveDeals()].filter((d) => d.name === 'Zeta Labs')).toHaveLength(1)
    expect(env.engine.effective(tmp)).toBeUndefined()
  })
})

describe('Dev scenarios (armed for "the next save")', () => {
  const log = () => env.server.getDev().log
  /** Attempts of the (single) request in the log, oldest first, e.g. ['1:failed', '2:ok']. */
  const outcomes = (_id: string) => log().map((l) => `${l.attempt}:${l.outcome}`).reverse()
  const open = (n: number) => env.deals.filter((d) => d.stage === 'new').slice(0, n)

  it('Fail next save (all retries): every automatic attempt fails, it ends Not saved and listed as a problem; Retry then saves it once', async () => {
    const [d] = open(1)
    const applied0 = env.server.stats.applied
    env.server.armFailAll()
    expect(env.server.getDev().armed).toEqual(['Armed: the next save will fail on every attempt (ends Not saved)'])
    env.engine.edit(d!.id, { stage: 'contacted' })
    await settle(0)
    expect(env.engine.syncOf(d!.id)).toMatchObject({ status: 'saving', retrying: true }) // attempt 1 failed, waiting to retry
    await settle(400) // attempt 2
    expect(env.engine.syncOf(d!.id)).toMatchObject({ status: 'saving', retrying: true })
    await settle(1200) // attempt 3: out of automatic retries
    expect(env.engine.syncOf(d!.id)).toMatchObject({ status: 'failed' })
    expect([...env.engine.problems]).toEqual([d!.id]) // what the Failed view and tray list
    expect(env.engine.summary()).toMatchObject({ failed: 1, pending: 1 })
    expect(events.flatMap((e) => e.newFailures).map((f) => f.id)).toEqual([d!.id])
    expect(env.engine.effective(d!.id)!.stage).toBe('contacted') // the intent stays on screen
    expect(env.server.peek(d!.id)!.stage).toBe('new') // ... but the server never applied it
    expect(env.server.stats.applied).toBe(applied0)
    expect(outcomes(d!.id)).toEqual(['1:failed', '2:failed', '3:failed'])
    expect(log().every((l) => l.cause === 'scenario')).toBe(true)
    expect(env.server.getDev().armed).toEqual([]) // consumed

    env.engine.retry(d!.id) // a manual Retry is not failed again
    await settle(0)
    expect(env.engine.syncOf(d!.id)).toBeUndefined()
    expect(env.engine.problems.size).toBe(0)
    expect(env.server.peek(d!.id)).toMatchObject({ stage: 'contacted', version: d!.version + 1 })
    expect(env.server.stats.applied).toBe(applied0 + 1) // applied once
    expect(log()[0]).toMatchObject({ attempt: 4, outcome: 'ok' })
  })

  it('Fail next attempt (retry recovers): one attempt fails, the quiet retry succeeds, it is never Not saved', async () => {
    const [d] = open(1)
    const applied0 = env.server.stats.applied
    env.server.armFailOnce()
    env.engine.edit(d!.id, { stage: 'contacted' })
    await settle(0)
    expect(env.engine.syncOf(d!.id)).toMatchObject({ status: 'saving', retrying: true })
    await settle(400)
    expect(env.engine.syncOf(d!.id)).toBeUndefined()
    expect(env.engine.problems.size).toBe(0)
    expect(events.flatMap((e) => e.newFailures)).toEqual([])
    expect(env.server.peek(d!.id)).toMatchObject({ stage: 'contacted', version: d!.version + 1 })
    expect(env.server.stats.applied).toBe(applied0 + 1)
    expect(outcomes(d!.id)).toEqual(['1:failed', '2:ok'])
    expect(env.server.getDev().armed).toEqual([])
  })

  it('Response lost on next save: applied, the response is lost, the retry replays it; saved once, no double-apply', async () => {
    const [d] = open(1)
    const applied0 = env.server.stats.applied
    env.server.armResponseLost()
    env.engine.edit(d!.id, { stage: 'contacted' })
    await settle(0)
    expect(env.server.peek(d!.id)!.stage).toBe('contacted') // the server DID apply it
    expect(env.engine.syncOf(d!.id)).toMatchObject({ status: 'saving', retrying: true }) // the client does not know
    await settle(400)
    expect(env.engine.syncOf(d!.id)).toBeUndefined()
    expect(env.engine.problems.size).toBe(0)
    expect(env.server.stats.applied).toBe(applied0 + 1)
    expect(env.server.peek(d!.id)!.version).toBe(d!.version + 1) // not bumped twice
    expect(outcomes(d!.id)).toEqual(['1:response lost', '2:replayed'])
    expect(env.engine.effective(d!.id)!.stage).toBe('contacted')
  })

  it('only the next save is affected: reads never consume an armed scenario, and other deals save normally', async () => {
    const [a, b] = open(2)
    env.server.armFailAll()
    await env.server.changesSince(0) // polling
    await env.server.listDeals(() => {}) // loading
    expect(env.server.getDev().armed).toHaveLength(1) // still armed
    env.engine.edit(a!.id, { stage: 'contacted' }) // the next save: binds to it
    env.engine.edit(b!.id, { stage: 'contacted' }) // a different deal, sent right after
    await settle(2000)
    expect(env.engine.syncOf(a!.id)).toMatchObject({ status: 'failed' })
    expect(env.engine.syncOf(b!.id)).toBeUndefined()
    expect(env.server.peek(b!.id)!.stage).toBe('contacted')
    expect(env.server.peek(a!.id)!.stage).toBe('new')
  })

  it('scenarios queue: each one binds to a different save, in order', async () => {
    const [a, b, c] = open(3)
    env.server.armFailAll()
    env.server.armFailOnce()
    for (const d of [a, b, c]) env.engine.edit(d!.id, { stage: 'contacted' })
    await settle(2000)
    expect(env.engine.syncOf(a!.id)).toMatchObject({ status: 'failed' }) // fail-all
    expect(env.engine.syncOf(b!.id)).toBeUndefined() // fail-once recovered
    expect(env.server.peek(b!.id)!.stage).toBe('contacted')
    expect(env.server.peek(c!.id)!.stage).toBe('contacted') // nothing was armed for the third
    expect(env.engine.problems.size).toBe(1)
  })

  it('the request log shows deal, attempt number and outcome (ok / failed / response lost / conflict), newest first, at most 10', async () => {
    const d = open(12)
    for (const x of d) env.engine.edit(x.id, { stage: 'contacted' })
    await settle(10)
    expect(log()).toHaveLength(10)
    expect(log()[0]!.n).toBeGreaterThan(log()[9]!.n)
    expect(log().every((l) => l.kind === 'save' && l.attempt === 1 && l.outcome === 'ok' && l.label.includes('→ contacted'))).toBe(true)
    env.server.interfereNext('same') // a teammate edits the same field first: the save is a conflict
    const [e] = env.deals.filter((x) => x.stage === 'demo')
    env.engine.edit(e!.id, { stage: 'won' })
    await settle(10)
    expect(log()[0]).toMatchObject({ outcome: 'conflict', attempt: 1 })
  })

  it('the Failure rate slider still works and is labelled random', async () => {
    env.settings.set({ failureRate: 1, lostResponseShare: 0 })
    const [d] = open(1)
    env.engine.edit(d!.id, { stage: 'contacted' })
    await settle(2000)
    expect(env.engine.syncOf(d!.id)).toMatchObject({ status: 'failed' })
    expect(log().every((l) => l.cause === 'random' && l.outcome === 'failed')).toBe(true)
  })
})
