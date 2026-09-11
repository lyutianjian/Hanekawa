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

/**
 * `a - b`, clamped at zero per field.
 *
 * Only one caller: `SessionController` adds each request's usage to the running
 * total the moment it lands, then settles the run by adding whatever the
 * end-of-run figure holds *beyond* what it already counted — compaction and
 * subagent transcripts, which never come through `onRequestUsage`. The clamp is
 * the safety net for a run whose total somehow trails its own requests; a
 * negative token count on screen would be worse than a stale one.
 */
export function subtractTokenUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: Math.max(0, a.inputTokens - b.inputTokens),
    cacheReadInputTokens: Math.max(0, a.cacheReadInputTokens - b.cacheReadInputTokens),
    outputTokens: Math.max(0, a.outputTokens - b.outputTokens),
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
