import { randomUUID } from 'node:crypto'
import type {
  MessageQueuePriority,
  MessageQueueRecord,
  PersistedQueuedMessage,
  SessionRecord,
} from '../harness/types.js'
import type { ImageAttachmentRef, UserInput } from '../media/types.js'

export type QueuedMessage = PersistedQueuedMessage
export type PersistQueueRecord = (sessionId: string, record: MessageQueueRecord) => Promise<void>

/**
 * The inverse of `enqueue`: a persisted queue message back into the UserInput
 * every submission path speaks. Both shells' pumps hand off through this, so
 * the mapping from `content`/`images` to `text`/`images` cannot fork.
 */
export function queuedMessageToInput(message: QueuedMessage): UserInput {
  return {
    text: message.content,
    ...(message.images && message.images.length > 0 ? { images: message.images } : {}),
  }
}

const EMPTY_SNAPSHOT: readonly QueuedMessage[] = Object.freeze([])

/**
 * Messages the user submitted while a turn was running, persisted as
 * `message_queue` records so they survive a restart.
 *
 * One instance owns one session's queue. Every mutation goes through
 * {@link serialize}, so the persisted record and the in-memory snapshot can
 * never disagree: a rejected write leaves the snapshot untouched.
 *
 * `getSnapshot`/`subscribe` are shaped for `useSyncExternalStore` — the
 * snapshot is a frozen array whose identity only changes when the contents do.
 */
export class MessageQueue {
  private sessionId: string
  private readonly persist: PersistQueueRecord
  private snapshot: readonly QueuedMessage[] = EMPTY_SNAPSHOT
  private operationChain: Promise<void> = Promise.resolve()
  private readonly listeners = new Set<() => void>()

  constructor(sessionId: string, records: readonly SessionRecord[], persist: PersistQueueRecord) {
    this.sessionId = sessionId
    this.persist = persist
    this.replaceSnapshot(replayMessageQueue(records))
  }

  getSnapshot = (): readonly QueuedMessage[] => this.snapshot

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  async enqueue(
    input: UserInput,
    priority: MessageQueuePriority = 'next',
  ): Promise<QueuedMessage> {
    const message: QueuedMessage = Object.freeze({
      id: randomUUID(),
      content: input.text,
      priority,
      createdAt: new Date().toISOString(),
      ...(input.images && input.images.length > 0 ? { images: input.images } : {}),
    })

    return this.serialize(async () => {
      await this.persist(this.sessionId, {
        id: randomUUID(),
        type: 'message_queue',
        operation: 'enqueue',
        message,
        createdAt: new Date().toISOString(),
      })
      this.replaceSnapshot([...this.snapshot, message])
      return message
    })
  }

  async dequeue(): Promise<QueuedMessage | undefined> {
    return this.serialize(async () => {
      const message = this.snapshot[0]
      if (!message) return undefined
      await this.persist(this.sessionId, {
        id: randomUUID(),
        type: 'message_queue',
        operation: 'dequeue',
        messageId: message.id,
        createdAt: new Date().toISOString(),
      })
      this.replaceSnapshot(this.snapshot.slice(1))
      return message
    })
  }

  async clear(): Promise<void> {
    return this.serialize(async () => {
      if (this.snapshot.length === 0) return
      await this.persist(this.sessionId, {
        id: randomUUID(),
        type: 'message_queue',
        operation: 'clear',
        createdAt: new Date().toISOString(),
      })
      this.replaceSnapshot([])
    })
  }

  /** Rebuild the active queue after session records are replaced or truncated. */
  async hydrate(records: readonly SessionRecord[]): Promise<void> {
    return this.serialize(async () => {
      this.replaceSnapshot(replayMessageQueue(records))
    })
  }

  /** Point at a different session, discarding whatever the old one had pending. */
  async reset(sessionId: string, records: readonly SessionRecord[]): Promise<void> {
    return this.serialize(async () => {
      this.sessionId = sessionId
      this.replaceSnapshot(replayMessageQueue(records))
    })
  }

  /**
   * Move pending messages to a newly-created session without changing their
   * order. The compensating `clear` is written to the *old* session's log so
   * replaying it later cannot resurrect messages that now live elsewhere.
   */
  async migrateTo(nextSessionId: string, records: readonly SessionRecord[]): Promise<void> {
    return this.serialize(async () => {
      const previousSessionId = this.sessionId
      const pending = [...this.snapshot]

      for (const message of pending) {
        await this.persist(nextSessionId, {
          id: randomUUID(),
          type: 'message_queue',
          operation: 'enqueue',
          message,
          createdAt: new Date().toISOString(),
        })
      }
      if (pending.length > 0) {
        await this.persist(previousSessionId, {
          id: randomUUID(),
          type: 'message_queue',
          operation: 'clear',
          createdAt: new Date().toISOString(),
        })
      }

      this.sessionId = nextSessionId
      this.replaceSnapshot([...replayMessageQueue(records), ...pending])
    })
  }

  private replaceSnapshot(messages: readonly QueuedMessage[]): void {
    const next = messages.length === 0 ? EMPTY_SNAPSHOT : Object.freeze([...messages])
    if (sameMessages(this.snapshot, next)) return
    this.snapshot = next
    for (const listener of this.listeners) listener()
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationChain.then(operation, operation)
    this.operationChain = result.then(() => undefined, () => undefined)
    return result
  }
}

export function replayMessageQueue(records: readonly SessionRecord[]): QueuedMessage[] {
  const pending: QueuedMessage[] = []
  const ids = new Set<string>()

  for (const record of records) {
    if (record.type !== 'message_queue') continue
    if (record.operation === 'clear') {
      pending.length = 0
      ids.clear()
      continue
    }
    if (record.operation === 'enqueue') {
      if (!isValidQueuedMessage(record.message) || ids.has(record.message.id)) continue
      pending.push(Object.freeze({ ...record.message }))
      ids.add(record.message.id)
      continue
    }
    const index = pending.findIndex((message) => message.id === record.messageId)
    if (index >= 0) {
      ids.delete(record.messageId)
      pending.splice(index, 1)
    }
  }
  return pending
}

function sameMessages(left: readonly QueuedMessage[], right: readonly QueuedMessage[]): boolean {
  return left.length === right.length && left.every((message, index) => {
    const other = right[index]
    return other !== undefined
      && message.id === other.id
      && message.content === other.content
      && message.priority === other.priority
      && message.createdAt === other.createdAt
      && sameImages(message.images, other.images)
  })
}

/**
 * Refs compare by value: hydrate rebuilds the arrays from records, so identity
 * comparison would fire listeners on every replay, while skipping the field
 * entirely would miss a message whose images changed between snapshots.
 */
function sameImages(left: readonly ImageAttachmentRef[] | undefined, right: readonly ImageAttachmentRef[] | undefined): boolean {
  if (left === undefined || right === undefined) return left === right
  if (left.length !== right.length) return false
  return left.every((ref, index) => {
    const other = right[index]
    return other !== undefined
      && ref.id === other.id
      && ref.ownerSessionId === other.ownerSessionId
      && ref.name === other.name
      && ref.mimeType === other.mimeType
      && ref.width === other.width
      && ref.height === other.height
      && ref.byteLength === other.byteLength
  })
}

function isValidQueuedMessage(value: PersistedQueuedMessage): boolean {
  return typeof value?.id === 'string'
    && typeof value.content === 'string'
    && typeof value.createdAt === 'string'
    && (value.priority === 'now' || value.priority === 'next' || value.priority === 'later')
    && (value.images === undefined || (Array.isArray(value.images) && value.images.every(isValidImageRef)))
}

function isValidImageRef(ref: ImageAttachmentRef): boolean {
  return typeof ref?.id === 'string'
    && typeof ref.ownerSessionId === 'string'
    && typeof ref.name === 'string'
    && typeof ref.mimeType === 'string'
    && typeof ref.width === 'number'
    && typeof ref.height === 'number'
    && typeof ref.byteLength === 'number'
}
