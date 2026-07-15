import { randomUUID } from 'node:crypto'
import type {
  MessageQueuePriority,
  MessageQueueRecord,
  PersistedQueuedMessage,
  SessionRecord,
} from '../harness/types.js'

export type QueuedMessage = PersistedQueuedMessage
export type PersistQueueRecord = (sessionId: string, record: MessageQueueRecord) => Promise<void>

const EMPTY_SNAPSHOT: readonly QueuedMessage[] = Object.freeze([])

let sessionId: string | null = null
let persistRecord: PersistQueueRecord | null = null
let snapshot: readonly QueuedMessage[] = EMPTY_SNAPSHOT
let operationChain: Promise<void> = Promise.resolve()
const listeners = new Set<() => void>()

export function initializeMessageQueue(
  nextSessionId: string,
  records: readonly SessionRecord[],
  persist: PersistQueueRecord,
): void {
  sessionId = nextSessionId
  persistRecord = persist
  operationChain = Promise.resolve()
  replaceSnapshot(replayMessageQueue(records))
}

export function getMessageQueueSnapshot(): readonly QueuedMessage[] {
  return snapshot
}

export function subscribeMessageQueue(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export async function enqueueMessage(
  content: string,
  priority: MessageQueuePriority = 'next',
): Promise<QueuedMessage> {
  const message: QueuedMessage = Object.freeze({
    id: randomUUID(),
    content,
    priority,
    createdAt: new Date().toISOString(),
  })

  return serialize(async () => {
    const target = requireConfiguration()
    await target.persist(target.sessionId, {
      id: randomUUID(),
      type: 'message_queue',
      operation: 'enqueue',
      message,
      createdAt: new Date().toISOString(),
    })
    replaceSnapshot([...snapshot, message])
    return message
  })
}

export async function dequeueMessage(): Promise<QueuedMessage | undefined> {
  return serialize(async () => {
    const message = snapshot[0]
    if (!message) return undefined
    const target = requireConfiguration()
    await target.persist(target.sessionId, {
      id: randomUUID(),
      type: 'message_queue',
      operation: 'dequeue',
      messageId: message.id,
      createdAt: new Date().toISOString(),
    })
    replaceSnapshot(snapshot.slice(1))
    return message
  })
}

export async function clearMessageQueue(): Promise<void> {
  return serialize(async () => {
    if (snapshot.length === 0) return
    const target = requireConfiguration()
    await target.persist(target.sessionId, {
      id: randomUUID(),
      type: 'message_queue',
      operation: 'clear',
      createdAt: new Date().toISOString(),
    })
    replaceSnapshot([])
  })
}

/** Rebuild the active queue after session records are replaced or truncated. */
export async function hydrateMessageQueue(records: readonly SessionRecord[]): Promise<void> {
  return serialize(async () => {
    requireConfiguration()
    replaceSnapshot(replayMessageQueue(records))
  })
}

/** Move pending messages to a newly-created session without changing their order. */
export async function migrateMessageQueue(
  nextSessionId: string,
  records: readonly SessionRecord[],
): Promise<void> {
  return serialize(async () => {
    const current = requireConfiguration()
    const pending = [...snapshot]

    for (const message of pending) {
      await current.persist(nextSessionId, {
        id: randomUUID(),
        type: 'message_queue',
        operation: 'enqueue',
        message,
        createdAt: new Date().toISOString(),
      })
    }
    if (pending.length > 0) {
      await current.persist(current.sessionId, {
        id: randomUUID(),
        type: 'message_queue',
        operation: 'clear',
        createdAt: new Date().toISOString(),
      })
    }

    sessionId = nextSessionId
    replaceSnapshot([...replayMessageQueue(records), ...pending])
  })
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

function replaceSnapshot(messages: readonly QueuedMessage[]): void {
  const next = messages.length === 0 ? EMPTY_SNAPSHOT : Object.freeze([...messages])
  if (sameMessages(snapshot, next)) return
  snapshot = next
  for (const listener of listeners) listener()
}

function sameMessages(left: readonly QueuedMessage[], right: readonly QueuedMessage[]): boolean {
  return left.length === right.length && left.every((message, index) => {
    const other = right[index]
    return other !== undefined
      && message.id === other.id
      && message.content === other.content
      && message.priority === other.priority
      && message.createdAt === other.createdAt
  })
}

function requireConfiguration(): { sessionId: string; persist: PersistQueueRecord } {
  if (!sessionId || !persistRecord) throw new Error('Message queue has not been initialized')
  return { sessionId, persist: persistRecord }
}

function serialize<T>(operation: () => Promise<T>): Promise<T> {
  const result = operationChain.then(operation, operation)
  operationChain = result.then(() => undefined, () => undefined)
  return result
}

function isValidQueuedMessage(value: PersistedQueuedMessage): boolean {
  return typeof value?.id === 'string'
    && typeof value.content === 'string'
    && typeof value.createdAt === 'string'
    && (value.priority === 'now' || value.priority === 'next' || value.priority === 'later')
}
