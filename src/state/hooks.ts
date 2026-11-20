import { createContext, useContext, useSyncExternalStore } from 'react'
import type { PipelineApp } from './store'

export const AppContext = createContext<PipelineApp>(null as unknown as PipelineApp)
export const useAppInstance = (): PipelineApp => useContext(AppContext)

/** Subscribe to a slice of the app. The selector MUST return a referentially stable value. */
export function useApp<T>(selector: (a: PipelineApp) => T): T {
  const app = useContext(AppContext)
  return useSyncExternalStore(app.subscribe, () => selector(app))
}
