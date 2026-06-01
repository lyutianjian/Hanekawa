import { useState, useCallback, useRef, useEffect } from 'react'
import { randomUUID } from 'node:crypto'
import type { AgentLoop } from '../../harness/loop.js'
import type { ActiveModelRuntime } from '../../harness/loop.js'
import type { SessionStore } from '../../sessions/service.js'
import type { PermissionGate } from '../../harness/permissions.js'
import type { SessionMeta } from '../../sessions/service.js'
import type {
  SessionRecord,
  TokenUsage,
  ToolProgressEvent,
} from '../../harness/types.js'
import type { TUIDisplayItem, TUIUsage } from '../types.js'
import type { RecordProxy } from './usePermission.js'
import { CheckpointService } from '../../services/checkpoint/checkpointService.js'
import { logDiagnostics, summarizeDiagnosticsForTui } from '../../harness/diagnostics.js'
import { getToolActivityDescription } from '../../tools/display.js'
import { ENTER_PLAN_MODE_TOOL_NAME, EXIT_PLAN_MODE_TOOL_NAME } from '../../tools/toolNames.js'

interface UseAgentLoopOptions {
  loop: AgentLoop
  store: SessionStore
  session: SessionMeta
  permissionGate: PermissionGate
  recordProxy: RecordProxy
  existingRecords: SessionRecord[]
  initialSystemMessages?: TUIDisplayItem[]
  cwd?: string
  onRecordExternal?: (record: SessionRecord) => void
  onActiveModelChange?: (model: Omit<ActiveModelRuntime, 'provider'>) => void
  onInterrupt?: () => void
}

export function useAgentLoop({
  loop,
  store,
  session,
  permissionGate,
  recordProxy,
  existingRecords,
  initialSystemMessages = [],
  cwd,
  onRecordExternal,
  onActiveModelChange,
  onInterrupt,
}: UseAgentLoopOptions) {
  const [messages, setMessages] = useState<TUIDisplayItem[]>(() =>
    [...initialSystemMessages, ...recordsToDisplayItems(existingRecords)],
  )
  const [isStreaming, setIsStreaming] = useState(false)
  const [usage, setUsage] = useState<TUIUsage>({
    lastTurn: null,
    total: createEmptyUsage(),
  })
  const [spinnerSubText, setSpinnerSubText] = useState<string | undefined>()

  const abortControllerRef = useRef<AbortController | null>(null)
  // Track the most recent tool_use ID for each tool name (for approval matching)
  const lastToolUseIdRef = useRef<Map<string, string>>(new Map())
  const activeToolProgressRef = useRef<Map<string, ToolProgressEvent>>(new Map())
  const subagentProgressRef = useRef<Map<string, string>>(new Map())

  // CheckpointService for creating snapshots before each user message
  const checkpointServiceRef = useRef<CheckpointService | null>(null)
  const checkpointInitializedRef = useRef(false)

  // Initialize CheckpointService when session starts
  useEffect(() => {
    const effectiveCwd = cwd ?? process.cwd()
    const service = new CheckpointService(effectiveCwd, session.id)
    checkpointServiceRef.current = service

    service.init().then(() => {
      checkpointInitializedRef.current = true
    }).catch((err) => {
      // Graceful degradation: log and continue without checkpoints
      if (process.env.MYAGENT_DEBUG_PROVIDER === '1') {
        console.error(`[hanekawa][checkpoint] Failed to initialize CheckpointService: ${err instanceof Error ? err.message : String(err)}`)
      }
      checkpointInitializedRef.current = false
    })

    return () => {
      checkpointServiceRef.current = null
      checkpointInitializedRef.current = false
    }
  }, [session.id, cwd])

  useEffect(() => {
    setUsage({
      lastTurn: null,
      total: createEmptyUsage(),
    })
    lastToolUseIdRef.current.clear()
    activeToolProgressRef.current.clear()
    subagentProgressRef.current.clear()
    setSpinnerSubText(undefined)
  }, [session.id])

  // Wire up the permission gate's prompt function
  // This is done via the proxy pattern in the entry point

  const submit = useCallback(
    async (input: string) => {
      // Add user message — generate ID once, use everywhere
      const messageId = randomUUID()
      const userMsg: TUIDisplayItem = {
        kind: 'user',
        id: messageId,
        content: input,
        createdAt: new Date().toISOString(),
      }
      setMessages((prev) => [...prev, userMsg])

      // Create checkpoint BEFORE agent begins processing
      if (checkpointInitializedRef.current && checkpointServiceRef.current) {
        try {
          const result = await checkpointServiceRef.current.createCheckpoint(messageId)
          if (result.success && result.commitHash) {
            await store.addCheckpointMapping(session.id, messageId, result.commitHash)
          } else if (result.error) {
            if (process.env.MYAGENT_DEBUG_PROVIDER === '1') {
              console.error(`[hanekawa][checkpoint] Checkpoint creation failed: ${result.error}`)
            }
          }
        } catch (err) {
          // Graceful degradation: log and continue without checkpoint
          if (process.env.MYAGENT_DEBUG_PROVIDER === '1') {
            console.error(`[hanekawa][checkpoint] Error creating checkpoint: ${err instanceof Error ? err.message : String(err)}`)
          }
        }
      }

      setIsStreaming(true)

      const ac = new AbortController()
      abortControllerRef.current = ac

      try {
        const result = await loop.run(input, ac.signal, messageId)

        // Update usage
        setUsage((prev) => ({
          lastTurn: result.usage,
          total: addTokenUsage(prev.total, result.usage),
        }))
      } catch (err: unknown) {
        if (err instanceof Error && (err.name === 'AbortError' || (err as Error & { aborted?: boolean }).aborted)) {
          const interruptMsg: TUIDisplayItem = {
            kind: 'system',
            id: randomUUID(),
            content: await formatInterruptMessage(store, session.id, messageId),
            createdAt: new Date().toISOString(),
          }
          setMessages((prev) => [...prev, interruptMsg])
        } else {
          const errorMsg: TUIDisplayItem = {
            kind: 'error',
            id: randomUUID(),
            content: err instanceof Error ? err.message : String(err),
            createdAt: new Date().toISOString(),
          }
          setMessages((prev) => [...prev, errorMsg])
        }
      } finally {
        onActiveModelChange?.(loop.getActiveModel())
        setIsStreaming(false)
        abortControllerRef.current = null
        lastToolUseIdRef.current.clear()
        activeToolProgressRef.current.clear()
        subagentProgressRef.current.clear()
        setSpinnerSubText(undefined)
        setMessages((prev) => prev.filter((item) => item.kind !== 'tool_progress'))
      }
    },
    [loop, store, session.id, onActiveModelChange],
  )

  const handleProgress = useCallback((event: ToolProgressEvent) => {
    if (isHiddenToolCall(event.call.name)) return
    if (event.phase === 'started') {
      activeToolProgressRef.current.set(event.call.id, event)
      if (event.source?.type === 'subagent' && event.source.agentId) {
        subagentProgressRef.current.set(event.source.agentId, formatSingleToolProgress(event))
      }
    } else {
      activeToolProgressRef.current.delete(event.call.id)
      if (event.source?.type === 'subagent' && event.source.agentId) {
        subagentProgressRef.current.delete(event.source.agentId)
      }
    }

    const activeEvents = [...activeToolProgressRef.current.values()]
    const foregroundEvents = activeEvents.filter((candidate) => candidate.source?.type !== 'subagent')
    const backgroundEvents = activeEvents.filter((candidate) => candidate.source?.type === 'subagent')
    const content = foregroundEvents.length > 0
      ? formatToolProgress(foregroundEvents)
      : formatSubagentSpinnerProgress(backgroundEvents)
    const listContent = foregroundEvents.length > 1 ? content : undefined
    setSpinnerSubText(content)
    setMessages((prev) => {
      const withoutProgress = prev.filter((item) => item.kind !== 'tool_progress')
      const withTaskProgress = withoutProgress.map((item) => {
        if (item.kind !== 'subagent_task') return item
        return {
          ...item,
          progress: subagentProgressRef.current.get(item.record.agentId),
        }
      })
      if (!listContent) return withTaskProgress
      return [
        ...withTaskProgress,
        {
          kind: 'tool_progress' as const,
          id: 'tool-progress',
          content: listContent,
          createdAt: new Date().toISOString(),
        },
      ]
    })
  }, [])

  // Handle records from ToolRunner (via onRecord callback)
  const handleRecord = useCallback(
    (record: SessionRecord) => {
      // Update display items based on record type
      // Note: persistence is handled by loop.appendRecord, not here
      if (record.type === 'tool_use' && !isHiddenToolCall(record.tool)) {
        // Track tool name -> tool_use ID mapping for approval matching
        lastToolUseIdRef.current.set(record.tool, record.id)

        // Update existing pending tool call or create new one
        setMessages((prev) => {
          const idx = prev.findIndex(
            (m) => m.kind === 'tool_call' && m.toolUseId === record.id,
          )
          if (idx >= 0) {
            const updated = [...prev]
            const item = { ...updated[idx] } as Extract<TUIDisplayItem, { kind: 'tool_call' }>
            item.status = 'running'
            item.input = record.input
            updated[idx] = item
            return updated
          }
          // Create new if not found (e.g., from direct tool execution)
          return [
            ...prev,
            {
              kind: 'tool_call' as const,
              id: randomUUID(),
              toolUseId: record.id,
              tool: record.tool,
              input: record.input,
              status: 'running' as const,
              createdAt: record.createdAt,
            },
          ]
        })
      } else if (record.type === 'tool_approval' && !isHiddenToolCall(record.tool)) {
        // Match approval to tool_use by looking up the most recent tool_use ID for this tool name
        const toolUseId = lastToolUseIdRef.current.get(record.tool)
        setMessages((prev) => {
          const idx = prev.findIndex(
            (m) => m.kind === 'tool_call' && m.toolUseId === toolUseId,
          )
          if (idx >= 0) {
            const updated = [...prev]
            const item = { ...updated[idx] } as Extract<TUIDisplayItem, { kind: 'tool_call' }>
            item.status = record.approved ? 'approved' : 'denied'
            updated[idx] = item
            return updated
          }
          return prev
        })
      } else if (record.type === 'tool_result' && !isHiddenToolCall(record.tool)) {
        setMessages((prev) => {
          // Find by matching tool_use ID
          const idx = prev.findIndex(
            (m) => m.kind === 'tool_call' && m.toolUseId === record.toolUseId,
          )
          if (idx >= 0) {
            const updated = [...prev]
            const item = { ...updated[idx] } as Extract<TUIDisplayItem, { kind: 'tool_call' }>
            item.status = record.ok ? 'done' : 'error'
            item.result = record.content
            item.resultDisplay = record.display
            item.errorCode = record.errorCode
            updated[idx] = item
            return updated
          }
          return prev
        })
      } else if (record.type === 'message' && record.role === 'assistant') {
        setMessages((prev) => {
          if (prev.some((m) => m.kind === 'assistant' && m.id === record.id)) return prev
          return [
            ...prev,
            {
              kind: 'assistant' as const,
              id: record.id,
              content: record.content,
              createdAt: record.createdAt,
            },
          ]
        })
      } else if (record.type === 'compact_boundary') {
        setMessages((prev) => [
          ...prev,
          {
            kind: 'compact_boundary' as const,
            id: randomUUID(),
            summary: record.summary,
          },
        ])
      } else if (record.type === 'compact_attempt_failed') {
        setMessages((prev) => [
          ...prev,
          {
            kind: 'compact_attempt_failed' as const,
            id: record.id,
            record,
          },
        ])
      } else if (record.type === 'subagent_task') {
        setMessages((prev) => [
          ...prev.filter((item) => !(item.kind === 'subagent_task' && item.record.agentId === record.agentId)),
          {
            kind: 'subagent_task' as const,
            id: `subagent-task-${record.agentId}`,
            record,
            progress: subagentProgressRef.current.get(record.agentId),
            createdAt: record.createdAt,
          },
        ])
      }

      onRecordExternal?.(record)
    },
    [store, session.id, onRecordExternal],
  )

  // Inject handleRecord into the record proxy so ToolRunner events reach React state
  useEffect(() => {
    recordProxy.setHandler(handleRecord)
    recordProxy.setProgressHandler(handleProgress)
    return () => {
      recordProxy.setHandler(() => {})
      recordProxy.setProgressHandler(() => {})
    }
  }, [recordProxy, handleRecord, handleProgress])

  const interrupt = useCallback(() => {
    onInterrupt?.()
    abortControllerRef.current?.abort()
  }, [onInterrupt])

  /**
   * Reload messages from the session store (e.g., after truncation).
   * Returns the reloaded records for further processing.
   */
  const reloadMessages = useCallback(async () => {
    const loaded = await store.loadRecordsWithDiagnostics(session.id)
    logDiagnostics(loaded.diagnostics)
    const summary = summarizeDiagnosticsForTui(loaded.diagnostics)
    const systemItems: TUIDisplayItem[] = summary
      ? [{
          kind: 'system',
          id: randomUUID(),
          content: summary,
          createdAt: new Date().toISOString(),
        }]
      : []
    setMessages([...systemItems, ...recordsToDisplayItems(loaded.records)])
    return loaded.records
  }, [store, session.id])

  return {
    messages,
    setMessages,
    isStreaming,
    spinnerSubText,
    usage,
    submit,
    interrupt,
    handleRecord,
    reloadMessages,
  }
}

function formatToolProgress(events: ToolProgressEvent[]): string | undefined {
  if (events.length === 0) return undefined
  if (events.length === 1) {
    const event = events[0]
    if (!event) return undefined
    return formatSingleToolProgress(event)
  }

  const counts = new Map<string, number>()
  for (const event of events) {
    const name = formatScopedToolName(event)
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }

  if (counts.size === 1) {
    const first = events[0]
    const name = formatScopedToolName(first)
    if (first?.call.name === 'Read') return `Reading ${events.length} files in parallel...`
    return `Running ${events.length} ${name} calls in parallel...`
  }

  return `Running ${events.length} tools in parallel...`
}

function formatSingleToolProgress(event: ToolProgressEvent): string {
  const details = getToolActivityDescription(event.call.name, event.call.input) ?? formatToolProgressDetails(event.call.input)
  if (details && event.source?.type === 'subagent') {
    return `${formatScopedToolName(event)}: ${details}`
  }
  if (details) return details
  return `Running ${formatScopedToolName(event)}`
}

function formatSubagentSpinnerProgress(events: ToolProgressEvent[]): string | undefined {
  if (events.length === 0) return undefined

  const agentIds = new Set<string>()
  for (const event of events) {
    agentIds.add(event.source?.agentId ?? `${event.source?.agentType ?? 'agent'}:${event.call.id}`)
  }

  if (agentIds.size > 1) {
    return `${agentIds.size} agents running`
  }

  return formatToolProgress(events)
}

function formatScopedToolName(event: ToolProgressEvent | undefined): string {
  const name = event?.call.name ?? 'tool'
  if (event?.source?.type === 'subagent') {
    return `${event.source.agentType} > ${name}`
  }
  return name
}

function formatToolProgressDetails(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined
  const values = input as Record<string, unknown>
  const candidate = values.command ?? values.filePath ?? values.path ?? values.pattern ?? values.query
  return typeof candidate === 'string' && candidate.trim().length > 0
    ? truncateMiddle(candidate.trim(), 80)
    : undefined
}

function truncateMiddle(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value
  const keep = Math.max(1, Math.floor((maxLength - 3) / 2))
  return `${value.slice(0, keep)}...${value.slice(value.length - keep)}`
}

// Convert SessionRecord[] to TUIDisplayItem[] for initial display
export function recordsToDisplayItems(records: SessionRecord[]): TUIDisplayItem[] {
  const items: TUIDisplayItem[] = []
  const latestSubagentRecordId = new Map<string, string>()

  for (const record of records) {
    if (record.type === 'subagent_task') {
      latestSubagentRecordId.set(record.agentId, record.id)
    }
  }

  for (const record of records) {
    if (record.type === 'message') {
      items.push({
        kind: record.role === 'user' ? 'user' : record.role === 'assistant' ? 'assistant' : 'system',
        id: record.id,
        content: record.content,
        createdAt: record.createdAt,
      })
    } else if (record.type === 'tool_use') {
      if (isHiddenToolCall(record.tool)) continue
      items.push({
        kind: 'tool_call',
        id: randomUUID(),
        toolUseId: record.id,
        tool: record.tool,
        input: record.input,
        status: 'done', // Historical records are always done
        createdAt: record.createdAt,
      })
    } else if (record.type === 'tool_result') {
      if (isHiddenToolCall(record.tool)) continue
      // Find the matching tool_call and attach the result
      const matchingCall = items.find(
        (i) => i.kind === 'tool_call' && i.toolUseId === record.toolUseId,
      )
      if (matchingCall && matchingCall.kind === 'tool_call') {
        matchingCall.result = record.content
        matchingCall.resultDisplay = record.display
        matchingCall.status = record.ok ? 'done' : 'error'
        matchingCall.errorCode = record.errorCode
      }
    } else if (record.type === 'compact_boundary') {
      items.push({
        kind: 'compact_boundary',
        id: randomUUID(),
        summary: record.summary,
      })
    } else if (record.type === 'compact_attempt_failed') {
      items.push({
        kind: 'compact_attempt_failed',
        id: record.id,
        record,
      })
    } else if (record.type === 'subagent_task') {
      if (latestSubagentRecordId.get(record.agentId) !== record.id) continue
      const displayRecord = record.status === 'running'
        ? { ...record, status: 'interrupted' as const }
        : record
      items.push({
        kind: 'subagent_task',
        id: `subagent-task-${displayRecord.agentId}`,
        record: displayRecord,
        createdAt: displayRecord.createdAt,
      })
    }
  }

  return items
}

async function formatInterruptMessage(store: SessionStore, sessionId: string, userMessageId: string): Promise<string> {
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

export function isHiddenToolCall(toolName: string): boolean {
  return toolName === ENTER_PLAN_MODE_TOOL_NAME || toolName === EXIT_PLAN_MODE_TOOL_NAME
}

function addTokenUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    cacheReadInputTokens: a.cacheReadInputTokens + b.cacheReadInputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
  }
}

function createEmptyUsage(): TokenUsage {
  return {
    inputTokens: 0,
    cacheReadInputTokens: 0,
    outputTokens: 0,
  }
}
