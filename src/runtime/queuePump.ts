import type { QueuedMessage } from './messageQueue.js'
import { queuedMessageToInput } from './messageQueue.js'
import type { UserInput } from '../media/types.js'

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
  /** The message the pump would hand off next, if any. */
  headMessageId?: string
  /**
   * A message the runtime refused *before* accepting it (design §12.2, work
   * item 7) — an image the serving model cannot take, an attachment that is
   * gone. The pump stops rather than retrying, and starts again on its own once
   * the head changes (the user removed the item, or put another one in front of
   * it). A shell clears this when the model changes, which is the other thing
   * that can make the same message send.
   */
  blockedMessageId?: string
}

export function canPumpQueue(state: QueuePumpState): boolean {
  if (state.running) return false
  if (state.pending === 0) return false
  if (state.turnActive) return false
  if (state.uiBlocked) return false
  if (state.blockedMessageId !== undefined && state.blockedMessageId === state.headMessageId) return false
  return true
}

/** What one hand-off attempt did, so the shell knows what to draw and remember. */
export type QueueHandoffOutcome =
  /** Nothing was waiting. */
  | { kind: 'idle' }
  /** Accepted and run. Whatever the turn did afterwards is the turn's business. */
  | { kind: 'sent'; message: QueuedMessage }
  /**
   * The pump must stop on this message and say why. Either it was refused
   * before acceptance and is still waiting to be sent, or it was accepted and
   * its removal could not be persisted — in which case retrying would send it
   * twice, so stopping is the safe answer to both.
   */
  | { kind: 'blocked'; message: QueuedMessage; reason: string }
  /**
   * Accepted — the user record exists — and then the turn failed. Committed-turn
   * semantics apply: the message is consumed, and re-queueing it would duplicate
   * a message the conversation already contains.
   */
  | { kind: 'failed'; message: QueuedMessage; reason: string }

export interface QueueHandoffDeps {
  /** The head of the queue, unconsumed. */
  peek: () => QueuedMessage | undefined
  /** Removes an accepted message. */
  consume: (messageId: string) => Promise<void>
  /**
   * Runs the message. Must call `onAccepted` at the moment the input becomes
   * part of the conversation — for a submission, when its user record is on
   * disk — which is *not* the same moment this promise settles: it settles when
   * the whole turn is over.
   */
  deliver: (input: UserInput, context: { queuedMessageId: string; onAccepted: () => void }) => Promise<void>
}

/**
 * The queue's hand-off, shared by both shells (design §12.2, work items 4–6).
 *
 * The order is the whole point. The message is validated by the delivery path
 * while it is still queued, and only removed once the runtime has taken it, so
 * a refusal leaves the queue exactly as it was instead of consuming a message
 * into an error. The two failure kinds are on opposite sides of that line and
 * must not be collapsed: before acceptance the message still has to be sent,
 * after acceptance it must never be sent twice.
 */
export async function handOffQueuedMessage(deps: QueueHandoffDeps): Promise<QueueHandoffOutcome> {
  const message = deps.peek()
  if (!message) return { kind: 'idle' }

  let consumption: Promise<{ error: unknown } | undefined> | undefined
  const onAccepted = (): void => {
    // Fire-and-forget here, awaited below: this is called from inside a record
    // handler, which cannot wait for a disk write. The rejection is captured
    // rather than left floating, so it cannot become an unhandled rejection
    // while the turn it belongs to is still running.
    consumption ??= deps.consume(message.id).then(() => undefined, (error: unknown) => ({ error }))
  }

  let deliveryError: unknown
  try {
    await deps.deliver(queuedMessageToInput(message), { queuedMessageId: message.id, onAccepted })
    // A delivery that finished without announcing acceptance still handled the
    // message — a slash command, which produces no user record, takes this
    // path. Leaving it queued would run it again on the next tick.
    onAccepted()
  } catch (error) {
    deliveryError = error
  }

  const consumeFailure = consumption ? await consumption : undefined
  if (consumeFailure) {
    return {
      kind: 'blocked',
      message,
      reason: `the message was sent but could not be removed from the queue: ${describe(consumeFailure.error)}`,
    }
  }
  if (deliveryError === undefined) return { kind: 'sent', message }
  // `consumption` is the acceptance record: it exists only if `onAccepted` ran,
  // which the delivery path does the moment the user record is on disk.
  return consumption !== undefined
    ? { kind: 'failed', message, reason: describe(deliveryError) }
    : { kind: 'blocked', message, reason: describe(deliveryError) }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
