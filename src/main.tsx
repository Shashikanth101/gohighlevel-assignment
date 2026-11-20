import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { FakeServer } from './api/fakeServer'
import { SettingsStore } from './api/settings'
import { AppContext } from './state/hooks'
import { PipelineApp } from './state/store'
import { App } from './ui/App'
import './styles.css'

const params = new URLSearchParams(location.search)
const size = Math.max(100, Math.min(200_000, Number(params.get('size')) || 50_000))
const seed = Number(params.get('seed')) || 42

const settings = new SettingsStore()
const server = new FakeServer({ size, seed, settings })
const app = new PipelineApp({ api: server, server, settings })
void app.init()

// Handy for reviewers poking around in devtools.
;(window as unknown as { app: PipelineApp }).app = app

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppContext.Provider value={app}>
      <App />
    </AppContext.Provider>
  </StrictMode>,
)
