import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { act, cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { FakeServer } from '../src/api/fakeServer'
import { SettingsStore } from '../src/api/settings'
import { AppContext } from '../src/state/hooks'
import { PipelineApp } from '../src/state/store'
import { App } from '../src/ui/App'
import { rowRenders } from '../src/ui/DealRow'
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

  it('J/K and arrows move the focused row; Space selects; Shift+arrows extends', async () => {
    const user = userEvent.setup()
    await user.keyboard('j')
    expect(grid().getAttribute('aria-activedescendant')).toBe(`row-${app.view.ids[1]}`)
    await user.keyboard('{ArrowDown}k')
    expect(app.activeId).toBe(app.view.ids[1])
    await user.keyboard(' ')
    expect(app.selectedCount()).toBe(1)
    await user.keyboard('{Shift>}{ArrowDown}{ArrowDown}{/Shift}')
    expect(app.selectedCount()).toBe(3)
    expect(document.getElementById(`row-${app.view.ids[2]}`)).toHaveAttribute('aria-selected', 'true')
    await user.keyboard('{Escape}')
    expect(app.selectedCount()).toBe(0)
  })

  it('a number key moves the focused deal and shows an Undo toast; Z undoes', async () => {
    const user = userEvent.setup()
    const id = app.activeId!
    const before = app.engine.effective(id)!.stage
    await user.keyboard(before === 'won' ? '1' : '6')
    expect(await screen.findByText(/→/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument()
    await user.keyboard('z')
    expect(app.engine.effective(id)!.stage).toBe(before)
  })

  it('G then a letter switches view', async () => {
    const user = userEvent.setup()
    await user.keyboard('gm')
    expect(app.filter.view).toBe('mine')
    await user.keyboard('gf')
    expect(app.filter.view).toBe('failed')
  })

  it('single-key shortcuts are disabled while typing in the search box', async () => {
    const user = userEvent.setup()
    const before = app.activeId
    await user.click(screen.getByPlaceholderText(/Search deals/))
    await user.keyboard('5jk?z')
    expect(app.engine.overlay.size).toBe(0)
    expect(app.activeId).toBe(before)
    expect(app.ui.helpOpen).toBe(false)
    await user.keyboard('{Escape}')
    expect(grid()).toHaveFocus() // Esc leaves the field and returns to the grid
  })

  it('"/" focuses search, "?" opens help, Ctrl+K opens the palette, Esc closes and returns focus to the grid', async () => {
    const user = userEvent.setup()
    await user.keyboard('/')
    expect(screen.getByPlaceholderText(/Search deals/)).toHaveFocus()
    await user.keyboard('{Escape}')
    await user.keyboard('?')
    expect(screen.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(grid()).toHaveFocus()
    await user.keyboard('{Control>}k{/Control}')
    expect(screen.getByRole('dialog', { name: 'Command palette' })).toBeInTheDocument()
    await user.keyboard('help{Enter}')
    await act(async () => { await new Promise((r) => setTimeout(r, 10)) })
    expect(screen.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeInTheDocument()
  })

  it('M opens the stage picker and a number picks the stage', async () => {
    const user = userEvent.setup()
    const id = app.activeId!
    await user.keyboard('m')
    expect(screen.getByRole('dialog', { name: 'Move to stage' })).toBeInTheDocument()
    await user.keyboard('7')
    expect(app.engine.effective(id)!.stage).toBe('lost')
  })

  it('a failed save raises an assertive live message and a persistent tray state', async () => {
    const user = userEvent.setup()
    server.failNext(3, 'rejected')
    await user.keyboard('6')
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
