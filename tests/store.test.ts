import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeServer } from '../src/api/fakeServer'
import { SettingsStore } from '../src/api/settings'
import { PipelineApp } from '../src/state/store'
import { NOW, settle } from './helpers'
import { DAY } from '../src/domain/priority'
import type { Deal, StageId } from '../src/domain/types'

let app: PipelineApp
let server: FakeServer
beforeEach(async () => {
  vi.useFakeTimers()
  const settings = new SettingsStore({ failureRate: 0, teammateRate: 0, bulkItemFailureRate: 0 })
  server = new FakeServer({ size: 400, seed: 11, now: () => NOW, settings, instant: true })
  app = new PipelineApp({ api: server, server, settings, now: () => NOW })
  const p = app.init()
  await settle(0)
  await p
  app.setFilter({ view: 'all', stage: 'new' })
})
afterEach(() => {
  app.dispose()
  vi.useRealTimers()
})

const remote = (d: Deal, patch: Partial<Deal>) => ({ seq: 1, deal: { ...d, ...patch, version: d.version + 1, updatedBy: 5 } as Deal })
const dealAt = (i: number) => app.engine.effective(app.view.ids[i]!)!

describe('view snapshot vs. teammate changes', () => {
  it('a remote change to a filtered field leaves the view untouched, defers, and applies on request', () => {
    const ids = [...app.view.ids]
    const d = dealAt(3)
    app.setActive(d.id)
    app.engine.applyRemote([remote(d, { stage: 'won' })])

    expect(app.view.ids).toEqual(ids) // snapshot unchanged: no jumping rows
    expect(app.deferred.count).toBe(1)
    expect(app.getRow(d.id)!.deferredBy).toBe(5)
    expect(app.getRow(d.id)!.deal.stage).toBe('won') // data is current, position is not
    expect(app.counts.all.won.count).toBeGreaterThan(0) // rail counts are live

    app.applyDeferred()
    expect(app.view.ids).not.toContain(d.id)
    expect(app.view.ids.length).toBe(ids.length - 1)
    expect(app.deferred.count).toBe(0)
  })

  it('patches fields that do not affect filter/sort in place and flashes the row', () => {
    const ids = [...app.view.ids]
    const d = dealAt(2)
    const before = app.getRow(d.id)!
    app.engine.applyRemote([remote(d, { valueInr: d.valueInr + 1000 })])
    const after = app.getRow(d.id)!
    expect(app.view.ids).toEqual(ids)
    expect(app.deferred.count).toBe(0)
    expect(after.deal.valueInr).toBe(d.valueInr + 1000)
    expect(after.flash).toBeGreaterThan(before.flash)
  })

  it('a value edit IS deferred when the list is sorted by value', () => {
    app.setSort('value')
    const ids = [...app.view.ids]
    const d = dealAt(5)
    app.engine.applyRemote([remote(d, { valueInr: 1 })])
    expect(app.view.ids).toEqual(ids)
    expect(app.deferred.count).toBe(1)
  })

  it('counts a teammate moving a deal INTO my filter as a pending update, without inserting it', () => {
    const other = [...app.engine.effectiveDeals()].find((x) => x.stage === 'won')!
    const ids = [...app.view.ids]
    app.engine.applyRemote([remote(other, { stage: 'new' })])
    expect(app.view.ids).toEqual(ids)
    expect(app.deferred.entering.has(other.id)).toBe(true)
    expect(app.deferred.count).toBe(1)
    app.applyDeferred()
    expect(app.view.ids).toContain(other.id)
  })

  it('keeps the focused row pinned across remote changes and "Show updates"', () => {
    const d = dealAt(4)
    app.setActive(d.id)
    app.engine.applyRemote([remote(dealAt(0), { stage: 'lost' }), remote(dealAt(1), { stage: 'lost' })])
    app.applyDeferred()
    expect(app.activeId).toBe(d.id)
    expect(app.view.ids).toContain(d.id)
  })
})

describe('my own moves', () => {
  it('a move that no longer matches removes the row and advances focus to the next row', async () => {
    const [a, b, c] = [dealAt(0), dealAt(1), dealAt(2)]
    app.setActive(b.id)
    app.moveTo('contacted')
    expect(app.view.ids).not.toContain(b.id)
    expect(app.activeId).toBe(c.id) // next row, focus never lost
    expect(app.view.ids[0]).toBe(a.id)
    // still tracked: it is saving, then settles
    expect(app.engine.syncOf(b.id)!.status).toBe('saving')
    await settle(0)
    expect(app.engine.server.get(b.id)!.stage).toBe('contacted')
  })

  it('moving the last row focuses the previous one', () => {
    const last = app.view.ids[app.view.ids.length - 1]!
    const prev = app.view.ids[app.view.ids.length - 2]!
    app.setActive(last)
    app.moveTo('won')
    expect(app.activeId).toBe(prev)
  })

  it('a failed move that left the list stays in the Failed view and the tray', async () => {
    const d = dealAt(0)
    server.failNext(3, 'rejected')
    app.setActive(d.id)
    app.moveTo('lost')
    expect(app.view.ids).not.toContain(d.id)
    await settle(2000)
    expect(app.summary.failed).toBe(1)
    expect(app.liveAssertive).toMatch(/not saved/i)
    expect(app.toasts.some((t) => t.kind === 'error' && t.persistent)).toBe(true)
    app.setFilter({ view: 'failed', stage: null })
    expect(app.view.ids).toEqual([d.id])
    expect(app.getRow(d.id)!.status).toBe('failed')
  })

  it('Z undo issues a new mutation that restores the stage', async () => {
    const d = dealAt(0)
    app.setActive(d.id)
    app.moveTo('won')
    await settle(0)
    expect(server.peek(d.id)!.stage).toBe('won')
    app.undo()
    expect(app.engine.effective(d.id)!.stage).toBe('new')
    await settle(0)
    expect(server.peek(d.id)!.stage).toBe('new')
    expect(server.peek(d.id)!.version).toBe(d.version + 2) // two real writes, no rollback trick
  })

  it('moving a selection above 25 deals starts a bulk job; Lost above 50 asks for confirmation first', async () => {
    app.selectAllInView()
    const n = app.selectedCount()
    expect(n).toBeGreaterThan(50)
    app.moveTo('lost')
    expect(app.confirm).not.toBeNull()
    expect(app.confirm!.title).toContain(String(n))
    expect(app.jobs).toHaveLength(0)
    app.resolveConfirm(true)
    expect(app.jobs).toHaveLength(1)
    expect(app.jobs[0]!.total).toBe(n)
    expect(app.view.ids).toHaveLength(0) // all left the filter at once
    await settle(0)
    await settle(0)
    expect(app.jobs[0]!.status).toBe('done')
  })

  it('moves to Won in bulk do not need confirmation', () => {
    app.selectAllInView()
    app.moveTo('won')
    expect(app.confirm).toBeNull()
    expect(app.jobs).toHaveLength(1)
  })
})

describe('row-level subscriptions', () => {
  it('only the changed row\'s RowView identity changes', () => {
    const rows = app.view.ids.slice(0, 20).map((id) => app.getRow(id))
    const target = rows[7]!
    app.engine.edit(target.id, { valueInr: target.deal.valueInr + 5 })
    app.view.ids.slice(0, 20).forEach((id, i) => {
      const same = app.getRow(id) === rows[i]
      expect(same).toBe(i !== 7)
    })
  })
})

describe('echoes and reconnects', () => {
  it('my own write coming back through the feed is not a "teammate update"', async () => {
    const d = dealAt(0)
    app.setActive(d.id)
    app.moveTo('contacted') // leaves the filter; saves
    await settle(0)
    await app.pollNow() // the feed now returns my own change (updatedBy = me)
    await settle(0)
    expect(app.deferred.count).toBe(0)
    expect(app.getRow(d.id)!.deferredBy).toBeUndefined()
  })

  it('retryAll(filter) only resends the failures that match, grouped through the bulk job', async () => {
    server.failNext(3, 'rejected')
    app.setActive(dealAt(0).id)
    app.moveTo('won')
    await settle(2500)
    expect(app.summary.failed).toBe(1)
    expect(app.engine.retryAll(() => false)).toBe(0)
    expect(app.engine.retryAll()).toBe(1)
    await settle(0)
    expect(app.summary.pending).toBe(0)
  })
})

describe('scope, rail counts and relative moves', () => {
  const sum = (c: Record<string, { count: number }>) => Object.values(c).reduce((n, x) => n + x.count, 0)

  it('a stage filter in Today keeps the view as Today and filters its rows; clicking it again clears it', () => {
    app.setFilter({ view: 'today', stage: null, query: '' })
    const all = [...app.view.ids]
    const stage = (['contacted', 'demo', 'proposal', 'new'] as const).find((s) => all.some((i) => app.engine.effective(i)!.stage === s))!
    app.setStageFilter(stage)
    expect(app.filter).toMatchObject({ view: 'today', stage })
    expect(app.view.ids.length).toBeGreaterThan(0)
    expect(app.view.ids.length).toBeLessThan(all.length)
    expect(app.view.ids.every((i) => app.engine.effective(i)!.stage === stage)).toBe(true)
    expect(app.view.ids.every((i) => all.includes(i))).toBe(true) // still only Today deals
    app.setStageFilter(stage)
    expect(app.filter).toMatchObject({ view: 'today', stage: null })
    expect(app.view.ids).toEqual(all)
  })

  /** Turn some of my deals into Won/Lost deals closed `daysAgo` days ago (as if a teammate-side edit landed). */
  const closeMine = (n: number, daysAgo: number, stage: 'won' | 'lost' = 'won') => {
    const mine = [...app.engine.effectiveDeals()].filter((d) => d.ownerId === 0 && d.stage !== 'won' && d.stage !== 'lost').slice(0, n)
    app.engine.applyRemote(mine.map((d) => ({ seq: 1, deal: { ...d, stage, stageEnteredAt: NOW - daysAgo * 86_400_000, version: d.version + 1, updatedBy: 5 } })))
    return mine.map((d) => d.id)
  }

  it('(d) rail counts in Today equal the Today deals per stage, include Won/Lost, and add up to "All stages"', () => {
    closeMine(3, 2, 'won')
    closeMine(2, 4, 'lost')
    app.setFilter({ view: 'today', stage: null, query: '' })
    expect(app.scoped).not.toBeNull()
    const want: Record<string, number> = {}
    for (const i of app.view.ids) want[app.engine.effective(i)!.stage] = (want[app.engine.effective(i)!.stage] ?? 0) + 1
    for (const k of Object.keys(app.scoped!) as StageId[]) expect(app.scoped![k].count).toBe(want[k] ?? 0)
    expect(app.scoped!.won.count).toBeGreaterThanOrEqual(3)
    expect(app.scoped!.lost.count).toBeGreaterThanOrEqual(2)
    expect(sum(app.scoped!)).toBe(app.view.ids.length) // == the "All stages" total
    // closed deals follow every open one in the list
    const kinds = app.view.ids.map((i) => (['won', 'lost'].includes(app.engine.effective(i)!.stage) ? 'closed' : 'open'))
    expect(kinds.join('').replace(/^(open)+/, '')).toBe('closed'.repeat(kinds.filter((k) => k === 'closed').length))
    // a stage filter narrows the list but not the rail
    const total = app.view.ids.length
    app.setStageFilter('won')
    expect(sum(app.scoped!)).toBe(total)
    expect(app.view.ids.length).toBe(app.scoped!.won.count)
  })

  it('(c, store) moving a deal to Won from Today keeps its row in place; Refresh sorts it into the closed section', () => {
    app.setFilter({ view: 'today', stage: null, query: '' })
    const ids = [...app.view.ids]
    const id = ids[0]! // top open action item
    app.moveOne(id, 'won')
    expect(app.view.ids).toEqual(ids) // still there, same place
    expect(app.view.ids).toContain(app.activeId)
    expect(app.scoped!.won.count).toBeGreaterThan(0)
    app.rebuildView({ pin: true })
    expect(app.view.ids).toContain(id)
    expect(app.view.ids[0]).not.toBe(id) // now after the open items
  })

  it('rail counts follow the scope: search and the Failed view narrow them, and they stay live', () => {
    app.setFilter({ view: 'all', stage: null, query: '' })
    expect(app.scoped).toBeNull() // plain scopes use the incremental all/mine counts
    app.setFilter({ query: 'a' })
    expect(app.scoped).not.toBeNull()
    expect(sum(app.scoped!)).toBe(app.view.ids.length)
    const id = app.view.ids.find((i) => app.engine.effective(i)!.stage === 'new')!
    const n = app.scoped!.new.count
    app.engine.edit(id, { stage: 'won' })
    expect(app.scoped!.new.count).toBe(n - 1)
    expect(sum(app.scoped!)).toBe(app.countMatching()) // counts still equal what the scope lists
    app.setFilter({ view: 'failed', query: '' })
    expect(sum(app.scoped!)).toBe(0)
  })

  it('moveRelative moves each deal one stage from its own stage and clamps at the ends', () => {
    app.setFilter({ view: 'all', stage: null, query: '' })
    const pick = (stage: string) => app.view.ids.find((i) => app.engine.effective(i)!.stage === stage)!
    const [a, b, w] = [pick('new'), pick('demo'), pick('won')]
    ;[a, b, w].forEach((i) => app.toggleSelected(i!))
    app.moveRelative(1)
    expect([a, b, w].map((i) => app.engine.effective(i!)!.stage)).toEqual(['contacted', 'proposal', 'won']) // Won never advances
    app.setActive(a!)
    app.moveRelative(-1)
    app.moveRelative(-1) // New Lead has nowhere to go
    expect(app.engine.effective(a!)!.stage).toBe('new')
    app.setActive(w!)
    app.moveRelative(-1) // reopening a win goes to Negotiation
    expect(app.engine.effective(w!)!.stage).toBe('negotiation')
  })

  it('createDeal shows the new lead where the user can see it, focused', async () => {
    app.setFilter({ view: 'today', stage: null, query: '' })
    const id = app.createDeal({ name: 'Zeta Labs', valueInr: 500_000, licences: 3 })!
    expect(app.filter).toMatchObject({ view: 'mine', stage: 'new' })
    expect(app.view.ids[0]).toBe(id) // newest activity first
    expect(app.activeId).toBe(id)
    const before = app.counts.mine.new.count
    await settle(0)
    const real = app.activeId!
    expect(real).toMatch(/^D-/)
    expect(app.view.ids[0]).toBe(real)
    expect(app.counts.mine.new.count).toBe(before) // temp row swapped, not added twice
    expect(app.createDeal({ name: ' ', valueInr: 1, licences: 1 })).toBeNull()
  })

  it('a deal that is still being created is skipped by stage moves', async () => {
    const id = app.createDeal({ name: 'Zeta Labs', valueInr: 500_000, licences: 3 })!
    app.moveRelative(1)
    expect(app.engine.effective(id)!.stage).toBe('new')
    await settle(0)
  })
})

describe('moving to Won/Lost and reopening carry the next step and close date', () => {
  const open = () => app.view.ids.filter((i) => app.engine.effective(i)!.nextFollowUpAt !== null) // New Leads in the beforeEach view
  const snap = (ids: string[]) => ids.map((i) => { const d = app.engine.effective(i)!; return { stage: d.stage, next: d.nextFollowUpAt, close: d.expectedCloseAt, entered: d.stageEnteredAt } })
  const server = () => (id: string) => app.engine.server.get(id)!

  it('(b) a single move to Won/Lost clears the next step; undo restores it, the stage and the entry date', async () => {
    for (const stage of ['won', 'lost'] as const) {
      const id = open()[0]!
      const before = snap([id])[0]!
      expect(before.next).not.toBeNull()
      app.moveOne(id, stage)
      expect(app.engine.effective(id)!).toMatchObject({ stage, nextFollowUpAt: null })
      await settle(50)
      expect(server()(id)).toMatchObject({ stage, nextFollowUpAt: null }) // the server row too
      app.undo()
      await settle(50)
      expect(snap([id])[0]).toEqual({ ...before, entered: before.entered })
      expect(server()(id).nextFollowUpAt).toBe(before.next)
    }
  })

  it('(b) the K picker / selection path (small batch): every selected deal loses its next step, one undo restores all', async () => {
    const ids = open().slice(0, 4)
    const before = snap(ids)
    ids.forEach((i) => app.toggleSelected(i))
    app.moveTo('lost')
    expect(ids.map((i) => app.engine.effective(i)!.nextFollowUpAt)).toEqual([null, null, null, null])
    expect(app.selectedCount()).toBe(0)
    await settle(100)
    app.undo()
    await settle(100)
    expect(snap(ids)).toEqual(before)
  })

  it('(b) a bulk job (above the small-batch limit) sends the cleared next step, and undoing the job restores it', async () => {
    const ids = open().slice(0, 40)
    expect(ids.length).toBe(40)
    const before = snap(ids)
    ids.forEach((i) => app.toggleSelected(i))
    app.moveTo('won')
    expect(app.runner.list()).toHaveLength(1)
    await settle(5000)
    expect(ids.every((i) => app.engine.server.get(i)!.stage === 'won' && app.engine.server.get(i)!.nextFollowUpAt === null)).toBe(true)
    app.undo()
    await settle(5000)
    expect(snap(ids)).toEqual(before)
    expect(ids.every((i) => app.engine.server.get(i)!.nextFollowUpAt === before[ids.indexOf(i)]!.next)).toBe(true)
  })

  it('(b) L from Negotiation into Won, and a teammate closing a deal, follow the same rule', async () => {
    app.setFilter({ view: 'all', stage: 'negotiation' })
    const id = app.view.ids[0]!
    app.setActive(id)
    app.moveRelative(1)
    expect(app.engine.effective(id)).toMatchObject({ stage: 'won', nextFollowUpAt: null })
    const other = app.engine.effectiveDeals()
    const target = [...other].find((d) => d.stage === 'demo')!
    const srv = (app as unknown as { server: { teammateChange(id: string): string } }).server
    for (let i = 0; i < 40; i++) srv.teammateChange(target.id)
    await app.pollNow()
    await settle(10)
    for (const d of app.engine.effectiveDeals()) if (d.stage === 'won' || d.stage === 'lost') expect(d.nextFollowUpAt).toBeNull()
  })

  it('(d) reopening a closed deal (J) sets a follow-up in 3 days and a close date in 30; undo puts the closed state back', async () => {
    app.setFilter({ view: 'all', stage: 'won' })
    const id = app.view.ids[0]!
    const before = snap([id])[0]!
    expect(before.next).toBeNull()
    app.setActive(id)
    app.moveRelative(-1)
    const d = app.engine.effective(id)!
    expect(d.stage).toBe('negotiation')
    expect(d.nextFollowUpAt).toBe(NOW + 3 * DAY)
    expect(d.expectedCloseAt).toBe(NOW + 30 * DAY)
    await settle(50)
    expect(app.engine.server.get(id)).toMatchObject({ stage: 'negotiation', nextFollowUpAt: NOW + 3 * DAY, expectedCloseAt: NOW + 30 * DAY })
    app.undo()
    await settle(50)
    expect(snap([id])[0]).toEqual(before) // Won, no next step, the original close date
  })

  it('(d) reopening through the picker or a bulk selection does the same, and open-to-open moves leave dates alone', async () => {
    app.setFilter({ view: 'all', stage: 'lost' })
    const lost = app.view.ids.slice(0, 3)
    lost.forEach((i) => app.toggleSelected(i))
    app.moveTo('proposal')
    for (const i of lost) expect(app.engine.effective(i)).toMatchObject({ stage: 'proposal', nextFollowUpAt: NOW + 3 * DAY, expectedCloseAt: NOW + 30 * DAY })
    await settle(100)
    app.setFilter({ view: 'all', stage: 'contacted' })
    const c = app.view.ids[0]!
    const b = app.engine.effective(c)!
    app.moveOne(c, 'demo')
    expect(app.engine.effective(c)).toMatchObject({ nextFollowUpAt: b.nextFollowUpAt, expectedCloseAt: b.expectedCloseAt })
  })
})

describe('Failed view and tray', () => {
  it('list every failed deal; Retry, Revert and Retry all work from there', async () => {
    app.setFilter({ view: 'all', stage: 'new' })
    const ids = app.view.ids.slice(0, 3)
    const before = ids.map((i) => app.engine.effective(i)!.stage)
    for (const id of ids) {
      server.armFailAll()
      app.moveOne(id, 'contacted')
    }
    await settle(2500)
    expect(app.summary.failed).toBe(3)
    expect(app.problemIds().sort()).toEqual([...ids].sort())

    app.setView('failed')
    expect([...app.view.ids].sort()).toEqual([...ids].sort()) // the Failed view lists all three
    expect(ids.every((i) => app.getRow(i)!.status === 'failed')).toBe(true)

    app.retry(ids[0]!) // Retry
    await settle(50)
    expect(app.summary.failed).toBe(2)
    expect(server.peek(ids[0]!)!.stage).toBe('contacted')
    expect(app.view.ids).not.toContain(ids[0]) // saved: it leaves the Failed view

    app.revert(ids[1]!) // Revert: the intent is dropped, the row falls back to the server's
    expect(app.summary.failed).toBe(1)
    expect(app.engine.effective(ids[1]!)!.stage).toBe(before[1])
    expect(server.peek(ids[1]!)!.stage).toBe(before[1])
    expect(app.view.ids).not.toContain(ids[1])

    app.retryAll() // Retry all
    await settle(50)
    expect(app.summary).toMatchObject({ failed: 0, pending: 0 })
    expect(server.peek(ids[2]!)!.stage).toBe('contacted')
    expect(app.view.ids).toHaveLength(0)
    expect(app.problemIds()).toEqual([])
  })
})
