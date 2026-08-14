/**
 * Whether the queued-message pump may start the next message.
 *
 * Split out of the UI so the two shells can express "busy" differently: a
 * terminal is blocked by any modal overlay, a desktop window by a pending
 * permission request. The domain rule — one message at a time, never during a
 * turn — is the same either way.
 */
export interface QueuePumpState {
  /** How many messages are waiting. */
  pending: number
  /** A previous pump run has not finished handing off yet. */
  running: boolean
  /** A turn is in flight. */
  turnActive: boolean
  /** The UI is not in a state where it can accept a new message. */
  uiBlocked: boolean
}

export function canPumpQueue(state: QueuePumpState): boolean {
  if (state.running) return false
  if (state.pending === 0) return false
  if (state.turnActive) return false
  if (state.uiBlocked) return false
  return true
}
