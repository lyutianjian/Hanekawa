// 复刻自 ClaudeCode/src/state/AppState.tsx
// 简化：不包含 MailboxProvider/VoiceProvider

import React, { createContext, useContext, useState } from 'react'
import { useSyncExternalStore } from 'react'
import { createStore, type Store } from './store.js'
import { type AppState, getDefaultAppState } from './AppStateStore.js'

type AppStateStore = Store<AppState>

const AppStoreContext = createContext<AppStateStore | null>(null)
const HasAppStateContext = createContext(false)

export function AppStateProvider({
  children,
  initialState,
  externalStore,
}: {
  children: React.ReactNode
  initialState?: AppState
  externalStore?: AppStateStore
}) {
  const [store] = useState(() => externalStore ?? createStore(initialState ?? getDefaultAppState()))

  if (useContext(HasAppStateContext)) {
    throw new Error('AppStateProvider cannot be nested')
  }

  return (
    <HasAppStateContext.Provider value={true}>
      <AppStoreContext.Provider value={store}>
        {children}
      </AppStoreContext.Provider>
    </HasAppStateContext.Provider>
  )
}

function useAppStore(): AppStateStore {
  const store = useContext(AppStoreContext)
  if (!store) throw new Error('useAppStore must be used within AppStateProvider')
  return store
}

export function useAppState<T>(selector: (state: AppState) => T): T {
  const store = useAppStore()
  return useSyncExternalStore(
    store.subscribe,
    () => selector(store.getState()),
  )
}

export function useSetAppState(): (updater: (prev: AppState) => AppState) => void {
  return useAppStore().setState
}
