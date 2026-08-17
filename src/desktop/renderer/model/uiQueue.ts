import { UI_REQUEST_FALLBACKS } from '../../../runtime/protocol/wire.js'
import type { UiRequest, UiResponse } from '../../../runtime/protocol/wire.js'

/**
 * The blocking questions the host has asked and not yet had answered.
 *
 * One queue for all four kinds rather than one per kind: permission requests
 * genuinely arrive in parallel (the loop batches contiguous concurrency-safe
 * tool calls, so several gates can be waiting at once), and a plan prompt can
 * land while one of those is still open. Whoever is `active` is the one drawn;
 * the rest are named in an "Also waiting" line.
 *
 * Every entry *must* eventually be answered. `PermissionGate.approve` has no
 * timeout and `ToolRunner.run` does not pass its abort signal into it, so an
 * entry dropped on the floor parks the agent loop for the life of the process —
 * which is why `settleAllFallbacks` exists and why a transcript reset does not
 * clear this queue.
 *
 * DOM-free on purpose; see `diffRows.ts`.
 */

export interface UiQueueState {
  readonly entries: readonly UiRequest[]
  readonly activeId: string | undefined
}

export const EMPTY_UI_QUEUE: UiQueueState = { entries: [], activeId: undefined }

export function createUiQueue(): UiQueueState {
  return EMPTY_UI_QUEUE
}

/** FIFO. A duplicate `requestId` replaces its entry rather than doubling it. */
export function addUiRequest(state: UiQueueState, request: UiRequest): UiQueueState {
  const existing = state.entries.findIndex((entry) => entry.requestId === request.requestId)
  const entries = existing === -1
    ? [...state.entries, request]
    : state.entries.map((entry, index) => (index === existing ? request : entry))

  return { entries, activeId: state.activeId ?? request.requestId }
}

/**
 * Drops an answered entry and promotes the next one.
 *
 * Promotion follows position, not arrival, so answering the middle of three
 * moves focus to the one below rather than jumping back to the top.
 */
export function removeUiRequest(state: UiQueueState, requestId: string): UiQueueState {
  const index = state.entries.findIndex((entry) => entry.requestId === requestId)
  if (index === -1) return state

  const entries = state.entries.filter((entry) => entry.requestId !== requestId)
  if (state.activeId !== requestId) {
    return { entries, activeId: entries.length === 0 ? undefined : state.activeId }
  }
  const next = entries[index] ?? entries[entries.length - 1]
  return { entries, activeId: next?.requestId }
}

export function activeRequest(state: UiQueueState): UiRequest | undefined {
  if (state.activeId === undefined) return undefined
  return state.entries.find((entry) => entry.requestId === state.activeId)
}

export function activeIndex(state: UiQueueState): number {
  return state.entries.findIndex((entry) => entry.requestId === state.activeId)
}

export function permissionRequests(state: UiQueueState): Extract<UiRequest, { kind: 'permission' }>[] {
  return state.entries.filter(
    (entry): entry is Extract<UiRequest, { kind: 'permission' }> => entry.kind === 'permission',
  )
}

/** Tab / Shift+Tab across everything waiting. Wraps, unlike option movement. */
export function cycleActive(state: UiQueueState, direction: 'next' | 'prev'): UiQueueState {
  if (state.entries.length <= 1) return state
  const current = activeIndex(state)
  const step = direction === 'next' ? 1 : -1
  const size = state.entries.length
  const nextIndex = ((current === -1 ? 0 : current) + step + size) % size
  return { ...state, activeId: state.entries[nextIndex]?.requestId }
}

/**
 * Answers for everything still queued when the view goes away.
 *
 * Each kind gets *its own* fallback: deny a tool, reject a question, reject a
 * plan exit — but **approve** entering plan mode, since that only ever restricts
 * the agent. Do not collapse this into one blanket denial.
 */
export function settleAllFallbacks(
  state: UiQueueState,
): Array<{ requestId: string; response: UiResponse }> {
  return state.entries.map((entry) => ({
    requestId: entry.requestId,
    response: UI_REQUEST_FALLBACKS[entry.kind](),
  }))
}
