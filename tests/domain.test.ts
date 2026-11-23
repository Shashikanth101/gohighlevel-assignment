import { describe, expect, it } from 'vitest'
import { priority, closedChip, whyChips, DAY, HIGH_VALUE_INR, RECENTLY_CLOSED_DAYS } from '../src/domain/priority'
import { buildView, defaultSort, adjustCounts, emptyScoped, viewFields } from '../src/domain/selectors'
import { generateDeals } from '../src/api/seed'
import { closeCell } from '../src/ui/format'
import { movePatch, moveKind } from '../src/domain/patch'
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
      deal({ id: 'e', stage: 'won', nextFollowUpAt: NOW - 20 * DAY, stageEnteredAt: NOW - 30 * DAY }), // closed long ago
      deal({ id: 'f', nextFollowUpAt: NOW - 9 * DAY }), // ties with b -> id order
    ]
    const ids = buildView(deals, { view: 'today', stage: null, query: '' }, defaultSort('today'), { now: NOW })
    expect(ids).toEqual(['b', 'f', 'a'])
  })
})

describe('Today includes recently closed deals', () => {
  const today = (deals: Deal[]) => buildView(deals, { view: 'today', stage: null, query: '' }, defaultSort('today'), { now: NOW })
  const closed = (id: string, stage: 'won' | 'lost', daysAgo: number, p: Partial<Deal> = {}) =>
    deal({ id, stage, stageEnteredAt: NOW - daysAgo * DAY - 3_600_000, nextFollowUpAt: null, ...p })

  it('(a) a Won deal closed 2 days ago appears after every open item; closed deals run newest first', () => {
    const ids = today([
      closed('w5', 'lost', 5), closed('w2', 'won', 2), closed('w0', 'won', 0),
      deal({ id: 'low', nextFollowUpAt: NOW - 1 * DAY }), deal({ id: 'high', nextFollowUpAt: NOW - 20 * DAY, valueInr: 5_000_000 }),
    ])
    expect(ids).toEqual(['high', 'low', 'w0', 'w2', 'w5'])
  })
  it('(b) a deal closed 30 days ago (or just past the window), or not mine, does not', () => {
    const ids = today([
      closed('old', 'won', 30), closed('edge', 'lost', RECENTLY_CLOSED_DAYS + 1), closed('in', 'lost', RECENTLY_CLOSED_DAYS - 1),
      closed('theirs', 'won', 1, { ownerId: 4 }),
    ])
    expect(ids).toEqual(['in'])
  })
  it('closed rows carry a "Won 2d ago" / "Lost 5d ago" / "Won today" chip instead of priority chips', () => {
    const chip = (d: Deal) => whyChips(d, NOW).map((r) => `${r.kind}:${r.label}`)
    expect(chip(closed('a', 'won', 2))).toEqual(['won:Won 2d ago'])
    expect(chip(closed('b', 'lost', 5))).toEqual(['lost:Lost 5d ago'])
    expect(chip(deal({ id: 'c', stage: 'won', stageEnteredAt: NOW }))).toEqual(['won:Won today'])
    expect(closedChip(closed('d', 'won', 30), NOW)).toBeNull()
    expect(chip(deal({ nextFollowUpAt: NOW - 3 * DAY }))).toEqual(['overdue:Follow-up overdue 3d']) // open deals unchanged
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
  it('makes "next step" stage-aware: contact-by for New Lead, follow-up for open stages, none for Won/Lost', () => {
    for (const d of deals) {
      if (d.stage === 'won' || d.stage === 'lost') expect(d.nextFollowUpAt).toBeNull()
      else expect(d.nextFollowUpAt).not.toBeNull()
    }
    // (a) invariant: a Won/Lost deal never has a next step, and its close date is when it closed
    const closedDeals = deals.filter((d) => d.stage === 'won' || d.stage === 'lost')
    expect(closedDeals.length).toBeGreaterThan(10_000)
    expect(closedDeals.every((d) => d.nextFollowUpAt === null)).toBe(true)
    expect(closedDeals.every((d) => d.expectedCloseAt === d.stageEnteredAt)).toBe(true)
    const days = (stage: string) => deals.filter((d) => d.stage === stage).map((d) => (d.nextFollowUpAt! - NOW) / DAY)
    expect(Math.min(...days('new'))).toBeGreaterThanOrEqual(-3)
    expect(Math.max(...days('new'))).toBeLessThan(6)
    expect(Math.min(...days('contacted'))).toBeLessThan(-6) // normal follow-ups reach further back and out
    expect(Math.max(...days('contacted'))).toBeGreaterThan(10)
  })
  it('closes roughly 10-15% of Won/Lost deals within the last week, the rest earlier', () => {
    const term = deals.filter((d) => d.stage === 'won' || d.stage === 'lost')
    const recent = term.filter((d) => NOW - d.stageEnteredAt <= RECENTLY_CLOSED_DAYS * DAY).length / term.length
    expect(recent).toBeGreaterThan(0.1)
    expect(recent).toBeLessThan(0.15)
    expect(deals.filter((d) => d.ownerId === 0 && (d.stage === 'won' || d.stage === 'lost') && NOW - d.stageEnteredAt <= 7 * DAY).length).toBeGreaterThan(50)
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

describe('chip order', () => {
  const all = deal({ valueInr: 9_000_000, nextFollowUpAt: NOW - 4 * DAY, expectedCloseAt: NOW + 3 * DAY, stageEnteredAt: NOW - 30 * DAY })
  it('is fixed: high value, overdue, closing soon, stuck', () => {
    expect(priority(all, NOW).reasons.map((r) => r.kind)).toEqual(['value', 'overdue', 'closing', 'stuck'])
  })
  it('keeps that order when only some apply, whatever order the rules fire in', () => {
    const kinds = (d: Deal) => priority(d, NOW).reasons.map((r) => r.kind)
    expect(kinds(deal({ nextFollowUpAt: NOW - DAY, stageEnteredAt: NOW - 30 * DAY }))).toEqual(['overdue', 'stuck'])
    expect(kinds(deal({ expectedCloseAt: NOW + 2 * DAY, stageEnteredAt: NOW - 30 * DAY }))).toEqual(['closing', 'stuck'])
    expect(kinds(deal({ valueInr: 9_000_000, stageEnteredAt: NOW - 30 * DAY }))).toEqual(['value', 'stuck'])
    expect(kinds(deal({ valueInr: 9_000_000, expectedCloseAt: NOW + 2 * DAY }))).toEqual(['value', 'closing'])
  })
  it('gives every chip a compact form and a full label, and ordering never changes the score', () => {
    const p = priority(all, NOW)
    expect(p.reasons.every((r) => r.short.length > 0 && r.short.length <= r.label.length)).toBe(true)
    expect(p.reasons.find((r) => r.kind === 'overdue')!.label).toMatch(/^Follow-up overdue 4d$/)
    expect(priority({ ...all, stage: 'new' }, NOW).reasons.find((r) => r.kind === 'overdue')!.label).toMatch(/^Contact overdue/)
  })
})

describe('closed deals show closed-deal fields', () => {
  const now = NOW
  it('(c) the Close text of a Won/Lost deal is always past tense and never "in …"', () => {
    const deals = generateDeals(20_000, 42, NOW)
    const closed = deals.filter((d) => d.stage === 'won' || d.stage === 'lost')
    expect(closed.length).toBeGreaterThan(5000)
    for (const d of closed) {
      const c = closeCell(d, now)
      expect(c.text).toMatch(/^Closed (today|\d+d ago)$/)
      expect(c.text).not.toMatch(/\bin\b/)
      expect(c.tone).toBe('muted')
    }
    // even a closed deal with a stale future expected-close date reads from stageEnteredAt
    expect(closeCell(deal({ stage: 'won', stageEnteredAt: NOW - 10 * DAY, expectedCloseAt: NOW + 20 * DAY }), now).text).toBe('Closed 10d ago')
    expect(closeCell(deal({ stage: 'lost', stageEnteredAt: NOW }), now).text).toBe('Closed today')
  })
  it('open deals: expected close reads "in 4d", "today", or "3d overdue" (red), never "ago"', () => {
    expect(closeCell(deal({ expectedCloseAt: NOW + 4 * DAY }), now)).toEqual({ text: 'in 4d', tone: 'normal' })
    expect(closeCell(deal({ expectedCloseAt: NOW }), now).text).toBe('today')
    expect(closeCell(deal({ expectedCloseAt: NOW - 3 * DAY }), now)).toEqual({ text: '3d overdue', tone: 'overdue' })
  })
  it('stage moves carry the extra fields: close clears the next step, reopen sets defaults', () => {
    expect(moveKind('contacted', 'won')).toBe('close')
    expect(moveKind('won', 'lost')).toBe('plain')
    expect(moveKind('lost', 'negotiation')).toBe('reopen')
    expect(moveKind('demo', 'proposal')).toBe('plain')
    expect(movePatch('close', 'won', NOW)).toEqual({ stage: 'won', nextFollowUpAt: null })
    expect(movePatch('reopen', 'negotiation', NOW)).toEqual({ stage: 'negotiation', nextFollowUpAt: NOW + 3 * DAY, expectedCloseAt: NOW + 30 * DAY })
    expect(movePatch('plain', 'proposal', NOW)).toEqual({ stage: 'proposal' })
  })
})
