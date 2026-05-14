interface GlobalState {
  sessionId: string | null
  projectRoot: string
  cwd: string
  totalCostUSD: number
  totalAPIDuration: number
  totalToolDuration: number
}

let state: GlobalState = {
  sessionId: null,
  projectRoot: '',
  cwd: '',
  totalCostUSD: 0,
  totalAPIDuration: 0,
  totalToolDuration: 0,
}

export function getGlobalState(): GlobalState {
  return state
}

export function setGlobalState(partial: Partial<GlobalState>): void {
  state = { ...state, ...partial }
}

export function updateCost(additionalCost: number): void {
  state.totalCostUSD += additionalCost
}

export function updateDurations(apiDuration: number, toolDuration: number): void {
  state.totalAPIDuration += apiDuration
  state.totalToolDuration += toolDuration
}
