import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { act, cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { FakeServer } from '../src/api/fakeServer'
import { SettingsStore } from '../src/api/settings'
import { AppContext } from '../src/state/hooks'
import { PipelineApp } from '../src/state/store'
import { App } from '../src/ui/App'
import { rowRenders } from '../src/ui/DealRow'
import { inr } from '../src/ui/format'
import { NOW } from './helpers'

// jsdom has no layout: give the virtualizer a viewport so it renders a window of rows.
beforeAll(() => {
  Element.prototype.getBoundingClientRect = function () {
    return { width: 1200, height: 600, top: 0, left: 0, right: 1200, bottom: 600, x: 0, y: 0, toJSON() {} } as DOMRect
  }
  for (const [k, v] of [['offsetHeight', 600], ['offsetWidth', 1200], ['clientHeight', 600], ['clientWidth', 1200]] as const) {
    Object.defineProperty(HTMLElement.prototype, k, { configurable: true, value: v })
  }
  const RO = class { observe() {} unobserve() {} disconnect() {} }
  globalThis.ResizeObserver = RO
  window.ResizeObserver = RO
})

let app: PipelineApp
let server: FakeServer
beforeEach(async () => {
  const settings = new SettingsStore({ failureRate: 0, teammateRate: 0, bulkItemFailureRate: 0, pollMs: 60_000 })
  server = new FakeServer({ size: 600, seed: 21, now: () => NOW, settings, instant: true })
  app = new PipelineApp({ api: server, server, settings, now: () => NOW })
  await app.init()
  app.setFilter({ view: 'all' })
  await act(async () => {
    render(<AppContext.Provider value={app}><App /></AppContext.Provider>)
  })
  await act(async () => { await new Promise((r) => setTimeout(r, 20)) }) // virtualizer measures its viewport asynchronously
})
afterEach(() => {
  cleanup()
  app.dispose()
})

const grid = () => screen.getByRole('grid', { name: 'Deals' })

describe('grid accessibility and keyboard', () => {
  it('is a role=grid, virtualized, and exposes the focused row through aria-activedescendant', () => {
    const rows = within(grid()).getAllByRole('row')
    expect(rows.length).toBeLessThan(60) // windowed: nowhere near 600
    expect(grid()).toHaveAttribute('aria-rowcount', '601')
    const active = grid().getAttribute('aria-activedescendant')!
    expect(active).toBe(`row-${app.view.ids[0]}`)
    expect(document.getElementById(active)).not.toBeNull()
    expect(grid()).toHaveFocus()
  })

  it('arrows and W/S move the focused row; Space selects; Shift+arrows extends; Esc clears', async () => {
    const user = userEvent.setup()
    await user.keyboard('s')
    expect(grid().getAttribute('aria-activedescendant')).toBe(`row-${app.view.ids[1]}`)
    await user.keyboard('{ArrowDown}w') // row 2, then back to row 1
    expect(app.activeId).toBe(app.view.ids[1])
    await user.keyboard('{ArrowUp}')
    expect(app.activeId).toBe(app.view.ids[0])
    await user.keyboard(' ')
    expect(app.selectedCount()).toBe(1)
    await user.keyboard('{Shift>}{ArrowDown}{ArrowDown}{/Shift}')
    expect(app.selectedCount()).toBe(3)
    expect(document.getElementById(`row-${app.view.ids[2]}`)).toHaveAttribute('aria-selected', 'true')
    await user.keyboard('{Escape}')
    expect(app.selectedCount()).toBe(0)
  })

  it('A/D (and left/right) switch between the rail and the table, and the active zone is shown', async () => {
    const user = userEvent.setup()
    expect(grid()).toHaveClass('zone-on')
    await user.keyboard('a')
    expect(app.ui.zone).toBe('rail')
    expect(screen.getByRole('navigation', { name: 'Stages' })).toHaveClass('zone-on')
    expect(grid()).not.toHaveClass('zone-on')
    expect(screen.getByText('Stage list')).toBeInTheDocument()
    const before = app.activeId
    await user.keyboard('{ArrowDown}{ArrowDown}') // rail cursor: All stages -> New Lead -> Contacted
    expect(app.activeId).toBe(before) // the table did not move
    await user.keyboard(' ')
    expect(app.filter.stage).toBe('contacted')
    await user.keyboard('{ArrowRight}')
    expect(app.ui.zone).toBe('table')
    await user.keyboard('{ArrowDown}')
    expect(app.activeIndex()).toBe(1)
  })

  it('L moves the focused deal to the next stage, J to the previous; Ctrl+Z undoes', async () => {
    const user = userEvent.setup()
    const id = app.view.ids.find((i) => app.engine.effective(i)!.stage === 'demo')!
    app.setActive(id)
    await user.keyboard('l')
    expect(app.engine.effective(id)!.stage).toBe('proposal')
    expect(await screen.findByText(/→ Proposal Sent/)).toBeInTheDocument()
    await user.keyboard('{Control>}z{/Control}')
    expect(app.engine.effective(id)!.stage).toBe('demo')
    await user.keyboard('j')
    expect(app.engine.effective(id)!.stage).toBe('contacted')
  })

  it('acts on the selection when there is one, else on the focused row', async () => {
    const user = userEvent.setup()
    const ids = app.view.ids.filter((i) => app.engine.effective(i)!.stage === 'new').slice(0, 3)
    for (const i of ids.slice(0, 2)) app.toggleSelected(i)
    app.setActive(ids[2]!)
    await user.keyboard('l')
    expect(ids.map((i) => app.engine.effective(i)!.stage)).toEqual(['contacted', 'contacted', 'new'])
  })

  it('K opens the stage picker; arrows then Enter choose', async () => {
    const user = userEvent.setup()
    const id = app.view.ids.find((i) => app.engine.effective(i)!.stage === 'new')!
    app.setActive(id)
    await user.keyboard('k')
    expect(screen.getByRole('dialog', { name: 'Move to stage' })).toBeInTheDocument()
    await user.keyboard('{ArrowDown}{ArrowDown}{Enter}') // New Lead -> Contacted -> Demo Done
    expect(app.engine.effective(id)!.stage).toBe('demo')
  })

  it('has no other shortcuts: number keys, M, G-nav, ?, /, S, Ctrl+K do nothing', async () => {
    const user = userEvent.setup()
    const before = app.activeId
    await user.keyboard('1234567mzrdu?/')
    await user.keyboard('gt{Control>}k{/Control}{Control>}a{/Control}')
    expect(app.engine.overlay.size).toBe(0)
    expect(app.filter.view).toBe('all')
    expect(app.activeId).toBe(before)
    expect(app.selectedCount()).toBe(0)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByPlaceholderText(/Search deals/)).not.toHaveFocus()
  })

  it('letter keys are disabled while typing in the search box', async () => {
    const user = userEvent.setup()
    const before = app.activeId
    await user.click(screen.getByPlaceholderText(/Search deals/))
    await user.keyboard('wasdnljk ')
    expect(app.engine.overlay.size).toBe(0)
    expect(app.activeId).toBe(before)
    expect(app.ui.newDealOpen).toBe(false)
    expect(app.ui.pickerOpen).toBe(false)
    expect(app.ui.zone).toBe('table')
    await user.keyboard('{Escape}')
    expect(grid()).toHaveFocus() // Esc leaves the field and returns to the grid
  })

  it('the sidebar ends with the grouped key list and the active zone', async () => {
    const user = userEvent.setup()
    const keys = screen.getByRole('region', { name: 'Keyboard shortcuts' })
    expect(screen.getByRole('navigation', { name: 'Stages' })).toContainElement(keys)
    expect(keys).toHaveTextContent('Keys act on: Deals table')
    for (const t of ['Move', 'Select', 'Act', 'Other', 'previous stage', 'next stage', 'move to…', 'new deal', 'clear', 'undo']) expect(keys).toHaveTextContent(t)
    await user.keyboard('a')
    expect(keys).toHaveTextContent('Keys act on: Stage list')
    expect(document.querySelector('.hints')).toBeNull() // the bottom bar is gone
  })

  it('the detail panel is always there and follows the focused row as the arrows move', async () => {
    const user = userEvent.setup()
    const panel = () => screen.getByRole('complementary', { name: 'Deal details' })
    expect(panel()).toHaveTextContent(app.engine.effective(app.view.ids[0]!)!.name)
    await user.keyboard('s')
    expect(panel()).toHaveTextContent(app.engine.effective(app.view.ids[1]!)!.name)
    await user.keyboard('{ArrowDown}')
    expect(panel()).toHaveTextContent(app.engine.effective(app.view.ids[2]!)!.name)
    expect(within(panel()).getByRole('group', { name: 'Move to stage' })).toBeInTheDocument()
    expect(within(panel()).getByRole('textbox', { name: /Value in rupees/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Move to…', hidden: false })).toBeNull() // no per-row button
  })

  it('with several deals selected the panel shows a summary, and the bulk bar keeps "Move to…"', async () => {
    const user = userEvent.setup()
    const ids = app.view.ids.slice(0, 3)
    ids.forEach((i) => app.toggleSelected(i))
    await act(async () => {})
    const panel = screen.getByRole('complementary', { name: 'Deal details' })
    expect(panel).toHaveTextContent('3 deals selected')
    expect(panel).toHaveTextContent('Total value')
    const total = ids.reduce((n, i) => n + app.engine.effective(i)!.valueInr, 0)
    expect(panel.textContent).toContain(inr(total))
    const perStage = within(within(panel).getByLabelText('Selected deals by stage')).getAllByText(/·/)
    expect(perStage.length).toBeGreaterThan(0)
    await user.click(within(screen.getByRole('region', { name: 'Bulk actions' })).getByRole('button', { name: /Move to…/ }))
    expect(screen.getByRole('dialog', { name: 'Move to stage' })).toBeInTheDocument()
  })

  it('an empty list shows an empty state in the panel', async () => {
    app.setFilter({ view: 'failed', stage: null, query: '' })
    await act(async () => {})
    expect(screen.getByRole('complementary', { name: 'Deal details' })).toHaveTextContent('No deal to show')
  })

  it('selecting 3 deals and moving them (L, K picker, or the bulk bar) clears the whole selection and leaves a valid focus', async () => {
    const user = userEvent.setup()
    app.setFilter({ view: 'all', stage: 'new' })
    await act(async () => {})
    const pick = () => {
      app.clearSelection()
      app.view.ids.slice(0, 3).forEach((i) => app.toggleSelected(i))
      return [...app.view.ids.slice(0, 3)]
    }
    const valid = () => expect(app.view.ids).toContain(app.activeId)

    let ids = pick()
    await act(async () => {})
    app.setUi({ zone: 'table' })
    ;(document.activeElement as HTMLElement | null)?.blur?.()
    grid().focus()
    await user.keyboard('l')
    expect(ids.map((i) => app.engine.effective(i)!.stage)).toEqual(['contacted', 'contacted', 'contacted'])
    expect(app.selectedCount()).toBe(0)
    expect(document.querySelectorAll('.row.selected')).toHaveLength(0)
    expect(ids.some((i) => app.activeId === i)).toBe(false) // focus advanced to a row that is still listed
    valid()

    ids = pick()
    await user.keyboard('k{ArrowDown}{Enter}')
    expect(app.selectedCount()).toBe(0)
    valid()

    ids = pick()
    await act(async () => {})
    await user.click(within(screen.getByRole('region', { name: 'Bulk actions' })).getByRole('button', { name: 'Demo Done' }))
    expect(app.selectedCount()).toBe(0)
    valid()
  })

  it.each([['Enter', '{Enter}'], ['Space', ' ']])('K picker confirmed with %s leaves no selection and a valid focus (one or several deals)', async (_name, confirm) => {
    const user = userEvent.setup()
    app.setFilter({ view: 'all', stage: 'new' })
    await act(async () => {})
    for (const count of [1, 3]) {
      app.clearSelection()
      const ids = app.view.ids.slice(0, count)
      ids.forEach((i) => app.toggleSelected(i))
      await act(async () => {})
      grid().focus()
      await user.keyboard('k')
      expect(screen.getByRole('dialog', { name: 'Move to stage' })).toBeInTheDocument()
      await user.keyboard(`{ArrowDown}${confirm}`) // New Lead -> Contacted
      expect(ids.map((i) => app.engine.effective(i)!.stage)).toEqual(ids.map(() => 'contacted'))
      expect(screen.queryByRole('dialog')).toBeNull()
      expect(app.selectedCount()).toBe(0)
      expect(document.querySelectorAll('.row.selected')).toHaveLength(0)
      expect(app.view.ids).toContain(app.activeId)
      expect(grid()).toHaveFocus() // focus is back on the table, so the next key works there
    }
  })

  describe('keys keep working after the mouse', () => {
    type User = ReturnType<typeof userEvent.setup>
    const rail = () => within(screen.getByRole('navigation', { name: 'Stages' }))
    const row = (i: number) => document.getElementById(`row-${app.view.ids[i]}`)!
    const onGrid = () => expect(document.activeElement).toBe(grid()) // DOM focus is back on the table

    /** After a mouse interaction: W/S move the cursor, Space toggles selection, L moves the deal. */
    async function keysWork(user: User) {
      app.clearSelection()
      await act(async () => {})
      const stageOf = (id: string) => app.engine.effective(id)!.stage
      if (app.ui.zone === 'rail') {
        // the cursor lives in the rail: S/W move it, Space toggles the stage filter, L/J/K still act on the focused deal
        const r0 = app.ui.railIndex
        await user.keyboard('s')
        expect(app.ui.railIndex).toBe(r0 + 1)
        await user.keyboard('w')
        expect(app.ui.railIndex).toBe(r0)
        const f0 = app.filter.stage
        await user.keyboard(' ')
        expect(app.filter.stage).not.toBe(f0)
        await user.keyboard(' ')
        expect(app.filter.stage).toBe(f0)
        const id = app.activeId!, before = stageOf(id)
        await user.keyboard('l')
        expect(stageOf(id)).not.toBe(before)
        return
      }
      const i0 = app.activeIndex()
      await user.keyboard('s')
      expect(app.activeIndex()).toBe(i0 + 1)
      await user.keyboard('w')
      expect(app.activeIndex()).toBe(i0)
      await user.keyboard(' ')
      expect(app.selectedCount()).toBe(1)
      await user.keyboard(' ')
      expect(app.selectedCount()).toBe(0) // toggled once per press: no native + handler double toggle
      const id = app.activeId!, before = stageOf(id)
      await user.keyboard('l')
      expect(stageOf(id)).not.toBe(before)
    }

    beforeEach(async () => {
      app.setFilter({ view: 'all', stage: 'new' }) // every row here can move forward with L
      app.setUi({ zone: 'table' })
      await act(async () => {})
      grid().focus()
    })

    it.each([
      ['a row checkbox', async (u: User) => u.click(within(row(3)).getByRole('checkbox'))],
      ['a row body', async (u: User) => u.click(within(row(3)).getByText(app.engine.effective(app.view.ids[3]!)!.name))],
      ['a rail stage', async (u: User) => u.click(rail().getByRole('button', { name: /^Demo Done/ }))],
      ['a detail panel stage button', async (u: User) => u.click(within(screen.getByRole('group', { name: 'Move to stage' })).getByRole('button', { name: 'Proposal Sent' }))],
      ['the search box, then Esc', async (u: User) => { await u.click(screen.getByPlaceholderText(/Search deals/)); await u.keyboard('{Escape}') }],
      ['the search box, then Enter', async (u: User) => { await u.click(screen.getByPlaceholderText(/Search deals/)); await u.keyboard('{Enter}') }],
      ['blank table space', async (u: User) => u.click(grid())],
      ['the header select-all checkbox (twice)', async (u: User) => { await u.click(screen.getByRole('checkbox', { name: 'Select all in this view' })); await u.click(screen.getByRole('checkbox', { name: 'Select all in this view' })) }],
      ['a sort header button', async (u: User) => u.click(screen.getByRole('button', { name: /^Deal/ }))],
      ['the Refresh button', async (u: User) => u.click(screen.getByRole('button', { name: 'Refresh' }))],
    ])('after clicking %s', async (_name, click) => {
      const user = userEvent.setup()
      await click(user)
      await act(async () => {})
      onGrid()
      await keysWork(user)
    })

    it('a mouse click on a row sets the focused row and the table zone, even from the rail zone', async () => {
      const user = userEvent.setup()
      await user.keyboard('a')
      expect(app.ui.zone).toBe('rail')
      await user.click(row(4))
      expect(app.activeId).toBe(app.view.ids[4])
      expect(app.ui.zone).toBe('table')
    })

    it('a click on a rail stage sets the zone to rail and applies the filter', async () => {
      const user = userEvent.setup()
      await user.click(rail().getByRole('button', { name: /^Contacted/ }))
      expect(app.ui.zone).toBe('rail')
      expect(app.filter.stage).toBe('contacted')
    })

    it('Esc inside the search box and Enter both return the keys to the table (also from the rail zone)', async () => {
      const user = userEvent.setup()
      await user.keyboard('a')
      await user.click(screen.getByPlaceholderText(/Search deals/))
      await user.keyboard('{Escape}')
      expect(app.ui.zone).toBe('table')
      onGrid()
      await user.keyboard('a')
      await user.click(screen.getByPlaceholderText(/Search deals/))
      await user.keyboard('{Enter}')
      expect(app.ui.zone).toBe('table')
      onGrid()
    })

    it('typing "wasd" (and every other shortcut letter) in the search box changes nothing in the table', async () => {
      const user = userEvent.setup()
      const before = { active: app.activeId, sel: app.selectedCount(), zone: app.ui.zone, stages: app.view.ids.slice(0, 5).map((i) => app.engine.effective(i)!.stage) }
      await user.click(screen.getByPlaceholderText(/Search deals/))
      await user.keyboard('wasdnljk ')
      expect(screen.getByPlaceholderText(/Search deals/)).toHaveValue('wasdnljk ')
      expect({ active: app.activeId, sel: app.selectedCount(), zone: app.ui.zone, stages: app.view.ids.slice(0, 5).map((i) => app.engine.effective(i)!.stage) }).toEqual(before)
      expect(app.engine.overlay.size).toBe(0)
      expect(app.ui.newDealOpen || app.ui.pickerOpen).toBe(false)
    })

    it('Space on a Tab-focused checkbox or button acts once, natively: the table handler does not also run', async () => {
      const user = userEvent.setup()
      const box = within(row(2)).getByRole('checkbox')
      await act(async () => box.focus())
      await user.keyboard(' ')
      expect(app.selectedCount()).toBe(1) // toggled by the checkbox only, not twice
      app.clearSelection()
      const refresh = screen.getByRole('button', { name: 'Refresh' })
      await act(async () => refresh.focus())
      await user.keyboard(' ')
      expect(app.selectedCount()).toBe(0) // the button was pressed; no row was toggled
    })

    it('a slider keeps its arrow keys; Esc hands the keyboard back to the table', async () => {
      const user = userEvent.setup()
      await act(async () => app.setUi({ devOpen: true }))
      const slider = screen.getAllByRole('slider')[0]!
      await act(async () => slider.focus())
      const i0 = app.activeIndex()
      await user.keyboard('{ArrowDown}')
      expect(app.activeIndex()).toBe(i0) // not hijacked
      await user.keyboard('{Escape}')
      onGrid()
      expect(app.ui.devOpen).toBe(true) // Esc only gave the keyboard back
      await keysWork(user)
    })

    it('closing a dialog opened from a button hands focus to the table, not back to the button', async () => {
      const user = userEvent.setup()
      await user.click(screen.getByRole('button', { name: '+ New deal' }))
      expect(screen.getByRole('dialog', { name: 'New deal' })).toBeInTheDocument()
      await user.keyboard('{Escape}')
      onGrid()
      await keysWork(user)
    })
  })

  it('Dev panel: an armed scenario shows "Armed", the request log records the attempts, and the indicator clears when consumed', async () => {
    const user = userEvent.setup()
    app.setFilter({ view: 'all', stage: 'new' })
    await act(async () => app.setUi({ devOpen: true }))
    const dev = screen.getByRole('complementary', { name: 'Dev panel' })
    const armed = () => within(dev).getByRole('status', { name: 'Armed scenarios' })
    expect(armed()).toHaveTextContent('Nothing armed')
    expect(within(dev).getByRole('button', { name: 'Fail next save (all retries)' })).toBeInTheDocument()
    expect(within(dev).getByRole('button', { name: 'Fail next attempt (retry recovers)' })).toBeInTheDocument()
    expect(within(dev).getByRole('button', { name: 'Response lost on next save' })).toBeInTheDocument()
    await user.click(within(dev).getByRole('button', { name: 'Fail next attempt (retry recovers)' }))
    expect(armed()).toHaveTextContent('Armed: the next save will fail once')
    grid().focus()
    await user.keyboard('l')
    await act(async () => { await new Promise((r) => setTimeout(r, 700)) }) // the retry fires after 400 ms
    const rows = within(within(dev).getByRole('list', { name: 'Write request log' })).getAllByRole('listitem')
    expect(rows[0]).toHaveTextContent(/try 2.*ok/)
    expect(rows[1]).toHaveTextContent(/try 1.*failed.*scenario/)
    expect(armed()).toHaveTextContent('Nothing armed')
  })

  it('a save that fails on every attempt ends Not saved: tray count, Failed view entry, then Retry saves it', async () => {
    const user = userEvent.setup()
    app.setFilter({ view: 'all', stage: 'new' })
    await act(async () => {})
    server.armFailAll()
    app.setActive(app.view.ids[0]!)
    const id = app.activeId!
    grid().focus()
    await user.keyboard('l')
    await act(async () => { await new Promise((r) => setTimeout(r, 1800)) }) // 400 ms + 1200 ms of automatic retries
    expect(screen.getByRole('button', { name: /1 not saved/ })).toBeInTheDocument()
    await user.click(screen.getByRole('tab', { name: /Failed/ }))
    await act(async () => {})
    expect(app.view.ids).toEqual([id])
    expect(document.getElementById(`row-${id}`)).toHaveTextContent('Not saved')
    await user.click(screen.getByRole('button', { name: /1 not saved/ }))
    await user.click(within(screen.getByRole('dialog', { name: 'Sync tray' })).getByRole('button', { name: 'Retry' }))
    await act(async () => { await new Promise((r) => setTimeout(r, 50)) })
    expect(app.engine.syncOf(id)).toBeUndefined()
    expect(server.peek(id)!.stage).toBe('contacted')
    expect(app.view.ids).toEqual([])
  }, 10_000)

  it('a partial move (some selected deals have nowhere to go) still clears the whole selection', async () => {
    const user = userEvent.setup()
    app.setFilter({ view: 'all', stage: null })
    await act(async () => {})
    const open = app.view.ids.find((i) => app.engine.effective(i)!.stage === 'demo')!
    const closed = app.view.ids.filter((i) => app.engine.effective(i)!.stage === 'won').slice(0, 2)
    ;[open, ...closed].forEach((i) => app.toggleSelected(i))
    grid().focus()
    await user.keyboard('l') // only one of the three can advance
    expect(app.engine.effective(open)!.stage).toBe('proposal')
    expect(app.selectedCount()).toBe(0)
    expect(document.querySelectorAll('.row.selected')).toHaveLength(0)
  })

  it('(e) the detail panel of a closed deal says "Closed" and hides Next step; an open deal keeps both', async () => {
    const closed = app.view.ids.find((i) => ['won', 'lost'].includes(app.engine.effective(i)!.stage))!
    const open = app.view.ids.find((i) => app.engine.effective(i)!.stage === 'demo')!
    const labels = () => [...screen.getByRole('complementary', { name: 'Deal details' }).querySelectorAll('dt')].map((e) => e.textContent)
    await act(async () => app.setActive(closed))
    expect(labels()).toContain('Closed')
    for (const gone of ['Next step', 'Contact by', 'Expected close']) expect(labels()).not.toContain(gone)
    const d = app.engine.effective(closed)!
    expect(screen.getByRole('complementary', { name: 'Deal details' })).toHaveTextContent(/Closed\s*(today|\d+d ago)/)
    expect(document.getElementById(`row-${closed}`)!.textContent).toMatch(/Closed (today|\d+d ago)/)
    expect(document.getElementById(`row-${closed}`)!.textContent).not.toMatch(/ in \d+d/)
    expect(d.nextFollowUpAt).toBeNull()
    await act(async () => app.setActive(open))
    expect(labels()).toEqual(expect.arrayContaining(['Next step', 'Expected close']))
    expect(labels()).not.toContain('Closed')
  })

  it('the header checkbox selects the whole view and offers "select all matching"', async () => {
    const user = userEvent.setup()
    await user.click(screen.getByRole('checkbox', { name: 'Select all in this view' }))
    expect(app.selectedCount()).toBe(app.view.ids.length)
    expect(screen.getByRole('button', { name: /Select all .* matching/ })).toBeInTheDocument()
    await user.click(screen.getByRole('checkbox', { name: 'Select all in this view' }))
    expect(app.selectedCount()).toBe(0)
  })

  it('N and the button open a form that creates the deal in New Lead at once', async () => {
    const user = userEvent.setup()
    await user.keyboard('n')
    const dlg = screen.getByRole('dialog', { name: 'New deal' })
    await user.click(within(dlg).getByRole('button', { name: 'Create deal' }))
    expect(within(dlg).getByRole('alert')).toHaveTextContent(/name/i) // validation keeps it open
    await user.type(within(dlg).getByLabelText('Deal name'), 'Zeta Labs')
    await user.type(within(dlg).getByLabelText('Value (₹)'), '7,50,000')
    await user.click(within(dlg).getByRole('button', { name: 'Create deal' }))
    expect(screen.queryByRole('dialog', { name: 'New deal' })).toBeNull()
    const id = app.activeId!
    const d = app.engine.effective(id)!
    expect([d.name, d.stage, d.valueInr, d.licences, d.ownerId]).toEqual(['Zeta Labs', 'new', 750000, 1, 0])
    expect(document.getElementById(`row-${id}`)).toHaveTextContent('Zeta Labs')
    await act(async () => { await new Promise((r) => setTimeout(r, 20)) })
    expect(app.activeId).toMatch(/^D-/) // temp id swapped for the server's, focus kept
    expect(app.view.ids).toContain(app.activeId)
  })

  it('a stage click in Today filters Today: the bar says "Today · Stage · N", × clears it, "All stages" clears it', async () => {
    const user = userEvent.setup()
    app.setView('today')
    await act(async () => {})
    const rail = () => within(screen.getByRole('navigation', { name: 'Stages' }))
    const stage = (['contacted', 'demo', 'proposal', 'new'] as const).find((s) => app.counts.mine[s].count > 0 && app.scoped![s].count > 0)!
    const label = { contacted: 'Contacted', demo: 'Demo Done', proposal: 'Proposal Sent', new: 'New Lead' }[stage]
    const n = app.scoped![stage].count
    await user.click(rail().getByRole('button', { name: new RegExp(`^${label}`) }))
    expect(app.filter).toMatchObject({ view: 'today', stage })
    const f = screen.getByRole('group', { name: 'Active filters' })
    expect(f).toHaveTextContent(new RegExp(`Today\\s*·\\s*${label}×\\s*·\\s*${n}`))
    expect(app.view.ids).toHaveLength(n)
    expect(rail().getByRole('button', { name: new RegExp(`^${label}`) })).toHaveTextContent(String(n)) // rail count == table count
    await user.click(within(f).getByRole('button', { name: /Remove .* filter/ }))
    expect(app.filter).toMatchObject({ view: 'today', stage: null })
    await user.click(rail().getByRole('button', { name: new RegExp(`^${label}`) }))
    await user.click(rail().getByRole('button', { name: /^All stages/ }))
    expect(app.filter).toMatchObject({ view: 'today', stage: null })
  })

  /** Make some of my open deals Won/Lost, closed `daysAgo` days ago (a change that arrived from elsewhere). */
  const closeMine = async (n: number, daysAgo: number, stage: 'won' | 'lost' = 'won') => {
    const mine = [...app.engine.effectiveDeals()].filter((d) => d.ownerId === 0 && d.stage !== 'won' && d.stage !== 'lost').slice(0, n)
    await act(async () => {
      app.engine.applyRemote(mine.map((d) => ({ seq: 1, deal: { ...d, stage, stageEnteredAt: NOW - daysAgo * 86_400_000, version: d.version + 1, updatedBy: 5 } })))
    })
  }

  it('Won in Today lists my recently closed deals with a "Won 2d ago" chip, and the rail counts are not dimmed', async () => {
    const user = userEvent.setup()
    await closeMine(2, 2)
    app.setView('today')
    await act(async () => {})
    const won = within(screen.getByRole('navigation', { name: 'Stages' })).getByRole('button', { name: /^Won/ })
    expect(won).not.toHaveClass('zero')
    await user.click(won)
    expect(app.filter).toMatchObject({ view: 'today', stage: 'won' })
    expect(app.view.ids.length).toBeGreaterThanOrEqual(2)
    expect(within(grid()).getAllByText('Won 2d ago').length).toBeGreaterThanOrEqual(2)
    expect(won).toHaveTextContent(String(app.view.ids.length))
  })

  it('Won in Today with nothing closed this week stays in Today, dimmed, and explains itself with a switch-view action', async () => {
    const user = userEvent.setup()
    // push every recently closed deal of mine out of the window
    const recent = [...app.engine.effectiveDeals()].filter((d) => d.ownerId === 0 && (d.stage === 'won' || d.stage === 'lost') && NOW - d.stageEnteredAt <= 7 * 86_400_000)
    await act(async () => {
      app.engine.applyRemote(recent.map((d) => ({ seq: 1, deal: { ...d, stageEnteredAt: NOW - 30 * 86_400_000, version: d.version + 1, updatedBy: 5 } })))
    })
    app.setView('today')
    await act(async () => {})
    const won = within(screen.getByRole('navigation', { name: 'Stages' })).getByRole('button', { name: /^Won/ })
    expect(won).toHaveTextContent('0')
    expect(won).toHaveClass('zero')
    await user.click(won)
    expect(app.filter).toMatchObject({ view: 'today', stage: 'won' })
    expect(app.view.ids).toHaveLength(0)
    expect(within(grid()).getByRole('status')).toHaveTextContent('Nothing was closed in the last 7 days.')
    await user.click(within(grid()).getByRole('button', { name: 'Show all Won deals' }))
    expect(app.filter).toMatchObject({ view: 'mine', stage: 'won' })
    expect(app.view.ids.length).toBeGreaterThan(0)
  })

  it('(c) moving a deal to Won from Today keeps the row where it is with a "Won today" chip', async () => {
    const user = userEvent.setup()
    app.setView('today')
    await act(async () => {})
    const id = app.view.ids.find((i) => app.engine.effective(i)!.stage === 'demo' || app.engine.effective(i)!.stage === 'proposal' || app.engine.effective(i)!.stage === 'negotiation')!
    app.setActive(id)
    const order = [...app.view.ids]
    await act(async () => app.moveOne(id, 'won'))
    expect(app.view.ids).toEqual(order) // nobody jumps
    const row = document.getElementById(`row-${id}`)!
    expect(row).toHaveTextContent('Won today')
    expect(within(row).getByText('Won today')).toHaveClass('chip-won')
    await user.click(screen.getByRole('button', { name: 'Refresh' }))
    expect(app.view.ids).toContain(id)
    expect(app.view.ids.indexOf(id)).toBeGreaterThan(0)
  })

  it('Space and W/S in the rail filter the current view the same way as a click', async () => {
    const user = userEvent.setup()
    app.setView('today')
    await act(async () => {})
    await user.keyboard('a') // rail zone, cursor on All stages
    await user.keyboard('s') // -> New Lead
    await user.keyboard(' ')
    expect(app.filter).toMatchObject({ view: 'today', stage: 'new' })
    await user.keyboard(' ')
    expect(app.filter).toMatchObject({ view: 'today', stage: null })
  })

  it('an empty list explains itself and offers a one-click fix', async () => {
    const user = userEvent.setup()
    app.setFilter({ view: 'mine', stage: 'won', query: 'zzzz-nothing' })
    await act(async () => {})
    expect(within(grid()).getByRole('status')).toHaveTextContent(/No Won deals match “zzzz-nothing”/)
    await user.click(within(grid()).getByRole('button', { name: 'Clear search' }))
    expect(app.filter.query).toBe('')
    expect(app.view.ids.length).toBeGreaterThan(0)
  })

  it('a failed save raises an assertive live message and a persistent tray state', async () => {
    const user = userEvent.setup()
    server.failNext(3, 'rejected')
    app.setActive(app.view.ids.find((i) => app.engine.effective(i)!.stage === 'new')!)
    await user.keyboard('l')
    await act(async () => { await new Promise((r) => setTimeout(r, 1800)) })
    const live = document.querySelector('[aria-live="assertive"]')!
    expect(live.textContent).toMatch(/not saved/i)
    expect(screen.getByRole('button', { name: /not saved/i })).toBeInTheDocument()
  }, 10_000)
})

describe('row-level subscriptions', () => {
  it('changing one deal re-renders only that deal\'s row', async () => {
    const id = app.view.ids[3]!
    rowRenders.ids.clear()
    await act(async () => {
      app.engine.edit(id, { valueInr: app.engine.effective(id)!.valueInr + 1234 })
    })
    await act(async () => { await new Promise((r) => setTimeout(r, 30)) }) // ack + "saved" marker: still just that row
    expect([...rowRenders.ids]).toEqual([id])
  })

  it('a teammate change to one deal re-renders only that row', async () => {
    const id = app.view.ids[5]!
    const d = app.engine.effective(id)!
    rowRenders.ids.clear()
    await act(async () => {
      app.engine.applyRemote([{ seq: 1, deal: { ...d, valueInr: d.valueInr + 1, version: d.version + 1, updatedBy: 3 } }])
    })
    expect([...rowRenders.ids]).toEqual([id])
  })

  it('moving the focus re-renders only the row losing it and the row gaining it', async () => {
    rowRenders.ids.clear()
    await act(async () => app.moveCursor(1))
    expect(rowRenders.ids.size).toBe(2)
  })
})
