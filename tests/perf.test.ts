/**
 * Performance budgets at the brief's real scale (50,000 deals), measured in Node.
 * Budgets are the targets from README; assertions allow 3x headroom so a slow CI box does not flake,
 * and the actual numbers are printed. Browser numbers (paint included) are in README.
 */
import { describe, expect, it } from 'vitest'
import { FakeServer } from '../src/api/fakeServer'
import { SettingsStore } from '../src/api/settings'
import { PipelineApp } from '../src/state/store'
import { defaultSort } from '../src/domain/selectors'
import { NOW } from './helpers'

const SLACK = 3
// Vitest swallows console.* by default here; stderr is how we surface the measured numbers.
const log = (m: string) => (globalThis as unknown as { process: { stderr: { write(s: string): void } } }).process.stderr.write(m)
const time = (fn: () => void): number => {
  const t = performance.now()
  fn()
  return performance.now() - t
}

describe('50k deals', async () => {
  const settings = new SettingsStore({ failureRate: 0, teammateRate: 0, bulkItemFailureRate: 0, pollMs: 60_000 })
  const server = new FakeServer({ size: 50_000, seed: 42, now: () => NOW, settings, instant: true })
  const app = new PipelineApp({ api: server, server, settings, now: () => NOW })
  await app.init()
  app.dispose()

  it('loads all deals and builds the default Today view', () => {
    expect(app.engine.server.size).toBe(50_000)
    expect(app.view.ids.length).toBeGreaterThan(300)
  })

  it('filter/sort change stays under 150ms (build only)', () => {
    const results: Record<string, number> = {}
    results['all, by activity'] = time(() => app.setFilter({ view: 'all' }))
    results['all, by value'] = time(() => app.setSort('value'))
    results['all, stage = New Lead (10k)'] = time(() => app.setStageFilter('new'))
    results['all, search "harbor"'] = time(() => app.setQuery('harbor'))
    results['my deals'] = time(() => app.setFilter({ view: 'mine', stage: null, query: '' }))
    results['today (priority sort)'] = time(() => app.setFilter({ view: 'today' }))
    log('\nview build (ms): ' + JSON.stringify(Object.fromEntries(Object.entries(results).map(([k, v]) => [k, Math.round(v * 10) / 10]))) + '\n')
    for (const [k, v] of Object.entries(results)) expect(v, k).toBeLessThan(150 * SLACK)
  })

  it('optimistic bulk apply of 10,000 deals stays under 100ms and keeps counts exact', () => {
    app.setFilter({ view: 'all', stage: 'new', query: '' })
    app.selectAllInView()
    const n = app.selectedCount()
    expect(n).toBeGreaterThan(9000)
    const ids = [...(app.selection.kind === 'ids' ? app.selection.ids : [])].slice(0, 10_000)
    const before = app.counts.all.lost.count
    const ms = time(() => app.startBulkMove(ids, 'lost'))
    log(`bulk optimistic apply of ${ids.length}: ${ms.toFixed(1)}ms\n`)
    expect(ms).toBeLessThan(100 * SLACK)
    expect(app.counts.all.lost.count).toBe(before + ids.length)
    // incremental counts equal a from-scratch recount
    const recount = { new: 0, lost: 0 }
    for (const d of app.engine.effectiveDeals()) {
      if (d.stage === 'new') recount.new++
      if (d.stage === 'lost') recount.lost++
    }
    expect(app.counts.all.new.count).toBe(recount.new)
    expect(app.counts.all.lost.count).toBe(recount.lost)
    expect(app.view.ids.length).toBe(0) // all left the filter in the same update
  })

  it('default sorts are what the README says', () => {
    expect(defaultSort('today').key).toBe('priority')
  })
})
