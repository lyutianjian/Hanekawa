import type { SessionRecord, TaskDisplaySnapshot, TokenUsage } from '../harness/types.js'
import type { SessionStore } from '../sessions/service.js'

/** Token accounting for a session: the last request plus the running total. */
export interface SessionUsage {
  lastRequest: TokenUsage | null
  total: TokenUsage
}

export function addTokenUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    cacheReadInputTokens: a.cacheReadInputTokens + b.cacheReadInputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
  }
}

export function createEmptyUsage(): TokenUsage {
  return {
    inputTokens: 0,
    cacheReadInputTokens: 0,
    outputTokens: 0,
  }
}

export function createEmptySessionUsage(): SessionUsage {
  return {
    lastRequest: null,
    total: createEmptyUsage(),
  }
}

export function findLatestTaskSnapshot(records: readonly SessionRecord[]): TaskDisplaySnapshot | undefined {
  for (const record of [...records].reverse()) {
    if (record.type !== 'tool_result') continue
    if (record.display?.taskSnapshot) return record.display.taskSnapshot
  }
  return undefined
}

export async function formatInterruptMessage(
  store: SessionStore,
  sessionId: string,
  userMessageId: string,
): Promise<string> {
  try {
    const loaded = await store.loadRecordsWithDiagnostics(sessionId)
    const interruption = [...loaded.records]
      .reverse()
      .find((record) => record.type === 'turn_interruption' && record.userMessageId === userMessageId)
    if (!interruption || interruption.type !== 'turn_interruption') return 'Interrupted.'
    const remaining = interruption.remainingTasks.length
    if (remaining === 0) return 'Interrupted.'
    return `Interrupted. ${remaining} ${remaining === 1 ? 'task' : 'tasks'} remaining.`
  } catch {
    return 'Interrupted.'
  }
}
