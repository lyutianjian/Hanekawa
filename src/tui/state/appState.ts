import { Store } from './store.js'

export interface AppState {
  // UI State
  isRunning: boolean
  streamingText: string
  streamingMessageId: string | null
  error: string | null
  startTime: string | null

  // Model State
  currentModel: string

  // Permission State
  pendingPermission: {
    toolName: string
    riskLevel: string
    input: unknown
    onAlwaysAllow?: () => void
  } | null
}

const initialState: AppState = {
  isRunning: false,
  streamingText: '',
  streamingMessageId: null,
  error: null,
  startTime: null,
  currentModel: '',
  pendingPermission: null,
}

export const appStore = new Store<AppState>(initialState)

// Convenience setters
export function setRunning(isRunning: boolean): void {
  appStore.setState({ isRunning })
}

export function setStreaming(streamingText: string, streamingMessageId: string | null): void {
  appStore.setState({ streamingText, streamingMessageId })
}

export function setError(error: string | null): void {
  appStore.setState({ error })
}

export function setStartTime(startTime: string | null): void {
  appStore.setState({ startTime })
}

export function setCurrentModel(model: string): void {
  appStore.setState({ currentModel: model })
}

export function setPendingPermission(permission: AppState['pendingPermission']): void {
  appStore.setState({ pendingPermission: permission })
}
