import { useSyncExternalStore } from 'react'
import { appStore } from './appState.js'
import type { AppState } from './appState.js'

export function useAppState<T>(selector: (state: AppState) => T): T {
  return useSyncExternalStore(
    (listener) => appStore.subscribe(listener),
    () => selector(appStore.getState()),
  )
}

// Convenience hooks
export function useIsRunning(): boolean {
  return useAppState((state) => state.isRunning)
}

export function useStreamingText(): string {
  return useAppState((state) => state.streamingText)
}

export function useError(): string | null {
  return useAppState((state) => state.error)
}

export function useCurrentModel(): string {
  return useAppState((state) => state.currentModel)
}

export function usePendingPermission() {
  return useAppState((state) => state.pendingPermission)
}
