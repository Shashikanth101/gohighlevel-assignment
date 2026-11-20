import { describe, expect, it } from 'vitest'
import * as S from '../src/state/selection'
import { generateDeals } from '../src/api/seed'
import { NOW } from './helpers'
import type { ViewFilter } from '../src/domain/types'

const ids = ['a', 'b', 'c', 'd', 'e', 'f']
const set = (s: S.Selection) => (s.kind === 'ids' ? [...s.ids].sort() : null)

describe('selection model', () => {
  it('toggles individual ids', () => {
    let s = S.toggle(S.EMPTY_SELECTION, 'b')
    s = S.toggle(s, 'd')
    expect(set(s)).toEqual(['b', 'd'])
    expect(set(S.toggle(s, 'b'))).toEqual(['d'])
  })

  it('selects a range in either direction, inclusive, keeping earlier picks', () => {
    let s = S.toggle(S.EMPTY_SELECTION, 'a')
    s = S.selectRange(s, ids, 'e', 'c')
    expect(set(s)).toEqual(['a', 'c', 'd', 'e'])
  })

  it('Shift+arrow extends away from the anchor and shrinks back toward it', () => {
    let s = S.setSelected(S.EMPTY_SELECTION, 'b', true)
    s = S.extendSelection(s, ids, 'b', 'b', 'c')
    s = S.extendSelection(s, ids, 'b', 'c', 'd')
    expect(set(s)).toEqual(['b', 'c', 'd'])
    s = S.extendSelection(s, ids, 'b', 'd', 'c') // back toward anchor
    expect(set(s)).toEqual(['b', 'c'])
    s = S.extendSelection(s, ids, 'b', 'c', 'b')
    s = S.extendSelection(s, ids, 'b', 'b', 'a') // cross over the anchor
    expect(set(s)).toEqual(['a', 'b'])
  })

  it('select-all-matching is a filter plus exclusions, counted without materialising', () => {
    const filter: ViewFilter = { view: 'all', stage: 'new', query: '' }
    let s = S.selectAllMatching(filter)
    expect(S.selectionCount(s, 10_000)).toBe(10_000)
    s = S.toggle(s, 'x1') // untick two rows
    s = S.toggle(s, 'x2')
    expect(S.selectionCount(s, 10_000)).toBe(9_998)
    expect(S.isSelected(s, 'x1')).toBe(false)
    expect(S.isSelected(s, 'x3')).toBe(true)
    s = S.toggle(s, 'x1') // re-tick
    expect(S.selectionCount(s, 10_000)).toBe(9_999)
    expect(S.selectRange(s, ids, 'a', 'c').kind).toBe('filter')
  })

  it('materialize freezes the selection: filter minus exclusions, using live data', () => {
    const deals = generateDeals(2000, 5, NOW)
    const filter: ViewFilter = { view: 'all', stage: 'new', query: '' }
    const matching = deals.filter((d) => d.stage === 'new').map((d) => d.id)
    let s = S.selectAllMatching(filter)
    s = S.toggle(s, matching[0]!)
    s = S.toggle(s, matching[5]!)
    const frozen = S.materialize(s, deals, { now: NOW })
    expect(frozen).toHaveLength(matching.length - 2)
    expect(frozen).not.toContain(matching[0])
    // data changes after the freeze do not alter the frozen list
    deals[1] = { ...deals[1]!, stage: 'new' }
    expect(frozen).toHaveLength(matching.length - 2)
    // id-set selections materialise to exactly those ids
    const picked = S.selectAllInView([deals[3]!.id, deals[9]!.id])
    expect(S.materialize(picked, deals, { now: NOW })).toEqual([deals[3]!.id, deals[9]!.id])
  })
})
