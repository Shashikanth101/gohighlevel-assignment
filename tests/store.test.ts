import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeServer } from '../src/api/fakeServer'
import { SettingsStore } from '../src/api/settings'
import { PipelineApp } from '../src/state/store'
import { NOW, settle } from './helpers'
import type { Deal } from '../src/domain/types'

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
