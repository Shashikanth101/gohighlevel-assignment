import { describe, expect, it } from 'vitest'
import { priority, DAY, HIGH_VALUE_INR } from '../src/domain/priority'
import { buildView, defaultSort, adjustCounts, emptyScoped, viewFields } from '../src/domain/selectors'
import { generateDeals } from '../src/api/seed'
import { NOW } from './helpers'
import type { Deal } from '../src/domain/types'

const deal = (p: Partial<Deal> = {}): Deal => ({
  id: 'D-1', name: 'Acme', licences: 5, valueInr: 100_000, ownerId: 0, stage: 'contacted', version: 1,
  lastActivityAt: NOW, stageEnteredAt: NOW - DAY, nextFollowUpAt: NOW + 3 * DAY, expectedCloseAt: NOW + 30 * DAY,
  updatedAt: NOW, updatedBy: 0, ...p,
})

describe('priority()', () => {
  it('has no reasons for a healthy deal', () => {
    expect(priority(deal(), NOW)).toEqual({ score: 0, reasons: [] })
  })
  it('flags an overdue follow-up with the number of days', () => {
    const p = priority(deal({ nextFollowUpAt: NOW - 3 * DAY }), NOW)
    expect(p.reasons.map((r) => r.kind)).toEqual(['overdue'])
    expect(p.reasons[0]!.label).toBe('Follow-up overdue 3d')
  })
  it('flags dwell only beyond the per-stage threshold (contacted = 5d)', () => {
    expect(priority(deal({ stageEnteredAt: NOW - 5 * DAY }), NOW).reasons).toEqual([])
    const p = priority(deal({ stageEnteredAt: NOW - 14 * DAY }), NOW)
    expect(p.reasons[0]).toMatchObject({ kind: 'stuck', label: 'Stuck in Contacted 14d' })
  })
  it('flags high value and a close date within 7 days (not later, not past)', () => {
    expect(priority(deal({ valueInr: HIGH_VALUE_INR }), NOW).reasons.map((r) => r.kind)).toEqual(['value'])
    expect(priority(deal({ expectedCloseAt: NOW + 4 * DAY }), NOW).reasons[0]).toMatchObject({ kind: 'closing', label: 'Closes in 4d' })
    expect(priority(deal({ expectedCloseAt: NOW + 8 * DAY }), NOW).reasons).toEqual([])
    expect(priority(deal({ expectedCloseAt: NOW - DAY }), NOW).reasons).toEqual([])
  })
  it('never ranks Won/Lost deals', () => {
    expect(priority(deal({ stage: 'won', nextFollowUpAt: NOW - 9 * DAY, valueInr: 9e9 }), NOW).reasons).toEqual([])
  })
  it('orders: more reasons and longer overdue score higher', () => {
    const a = priority(deal({ nextFollowUpAt: NOW - 10 * DAY }), NOW)
    const b = priority(deal({ nextFollowUpAt: NOW - 2 * DAY }), NOW)
    const c = priority(deal({ nextFollowUpAt: NOW - 2 * DAY, valueInr: 5_000_000 }), NOW)
    expect(a.score).toBeGreaterThan(b.score)
    expect(c.score).toBeGreaterThan(b.score)
    expect(c.reasons).toHaveLength(2)
  })
})

describe('Today view', () => {
  it('is my open deals with at least one reason, sorted by score desc, deterministically', () => {
    const deals = [
      deal({ id: 'a', nextFollowUpAt: NOW - 2 * DAY }),
      deal({ id: 'b', nextFollowUpAt: NOW - 9 * DAY }),
      deal({ id: 'c' }), // no reason
      deal({ id: 'd', ownerId: 3, nextFollowUpAt: NOW - 20 * DAY }), // not mine
      deal({ id: 'e', stage: 'won', nextFollowUpAt: NOW - 20 * DAY }), // closed
      deal({ id: 'f', nextFollowUpAt: NOW - 9 * DAY }), // ties with b -> id order
    ]
    const ids = buildView(deals, { view: 'today', stage: null, query: '' }, defaultSort('today'), { now: NOW })
    expect(ids).toEqual(['b', 'f', 'a'])
  })
})

describe('seed data', () => {
  const deals = generateDeals(50_000, 42, NOW)
  it('is deterministic for a seed', () => {
    expect(generateDeals(200, 42, NOW)).toEqual(generateDeals(200, 42, NOW))
    expect(generateDeals(200, 43, NOW)).not.toEqual(generateDeals(200, 42, NOW))
  })
  it('has the shape the brief asks for', () => {
    const mine = deals.filter((d) => d.ownerId === 0).length
    expect(mine).toBeGreaterThan(2200)
    expect(mine).toBeLessThan(2800)
    const byStage = new Map<string, number>()
    deals.forEach((d) => byStage.set(d.stage, (byStage.get(d.stage) ?? 0) + 1))
    expect(Math.max(...byStage.values())).toBeGreaterThan(9000)
    expect(Math.max(...byStage.values())).toBeLessThan(11000)
    expect(deals.some((d) => d.nextFollowUpAt !== null && d.nextFollowUpAt < NOW)).toBe(true)
    expect(deals.some((d) => now() - d.stageEnteredAt > 14 * DAY)).toBe(true)
    function now() { return NOW }
  })
  it('gives me a usable Today list', () => {
    const today = buildView(deals, { view: 'today', stage: null, query: '' }, defaultSort('today'), { now: NOW })
    expect(today.length).toBeGreaterThan(300)
    expect(today.length).toBeLessThan(2500)
  })
})

describe('incremental counts', () => {
  it('adjustCounts equals a full recount after arbitrary edits', () => {
    const deals = generateDeals(500, 3, NOW)
    const full = emptyScoped()
    deals.forEach((d) => adjustCounts(full, undefined, d))
    const inc = emptyScoped()
    deals.forEach((d) => adjustCounts(inc, undefined, d))
    const after = deals.map((d, i) => (i % 3 === 0 ? { ...d, stage: 'won' as const, valueInr: d.valueInr + 7, ownerId: (d.ownerId + 1) % 20 } : d))
    deals.forEach((d, i) => adjustCounts(inc, d, after[i]))
    const recount = emptyScoped()
    after.forEach((d) => adjustCounts(recount, undefined, d))
    expect(inc).toEqual(recount)
    expect(full).not.toEqual(recount)
  })
})

describe('viewFields', () => {
  it('includes the fields whose change can move/remove rows', () => {
    const f = viewFields({ view: 'mine', stage: 'new', query: '' }, { key: 'value', dir: 'desc' })
    expect([...f].sort()).toEqual(['ownerId', 'stage', 'valueInr'])
  })
})
