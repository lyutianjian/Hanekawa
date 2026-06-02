import { useState, useCallback, useRef, useEffect } from 'react'
import { randomUUID } from 'node:crypto'
import type { AgentLoop } from '../../harness/loop.js'
import type { ActiveModelRuntime } from '../../harness/loop.js'
import type { SessionStore } from '../../sessions/service.js'
import type { PermissionGate } from '../../harness/permissions.js'
import type { SessionMeta } from '../../sessions/service.js'
import type {
  SessionRecord,
  TaskDisplaySnapshot,
  TokenUsage,
  ToolProgressEvent,
} from '../../harness/types.js'
import type { TUIDisplayItem, TUIUsage } from '../types.js'
import type { RecordProxy } from './usePermission.js'
import { CheckpointService } from '../../services/checkpoint/checkpointService.js'
import { logDiagnostics, summarizeDiagnosticsForTui } from '../../harness/diagnostics.js'
import { getToolActivityDescription } from '../../tools/display.js'
import {
  appendStaticTranscriptItem,
  applyToolProgressToTranscriptState,
  applyTuiRecordToTranscriptState,
  clearToolProgress,
  createTranscriptState,
  isHiddenToolCall,
  recordsToDisplayItems,
  type TuiTranscriptState,
} from '../transcript.js'
import { rollbackInterruptedPromptIfSynthetic } from '../interruptRollback.js'

export { isHiddenToolCall, recordsToDisplayItems } from '../transcript.js'

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
  onRestoreInput?: (text: string) => void
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
  onRestoreInput,
}: UseAgentLoopOptions) {
  const [transcript, setTranscript] = useState<TuiTranscriptState>(() =>
    createTranscriptState([...initialSystemMessages, ...recordsToDisplayItems(existingRecords)]),
  )
  const [transcriptGeneration, setTranscriptGeneration] = useState(0)
  const [isStreaming, setIsStreaming] = useState(false)
  const [usage, setUsage] = useState<TUIUsage>({
    lastTurn: null,
    total: createEmptyUsage(),
  })
  const [spinnerSubText, setSpinnerSubText] = useState<string | undefined>()
  const [taskSnapshot, setTaskSnapshot] = useState<TaskDisplaySnapshot | undefined>(() =>
    findLatestTaskSnapshot(existingRecords),
  )

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
    const latestTaskSnapshot = findLatestTaskSnapshot(existingRecords)
    setTaskSnapshot(latestTaskSnapshot)
    setSpinnerSubText(undefined)
  }, [session.id, existingRecords])

  // Wire up the permission gate's prompt function
  // This is done via the proxy pattern in the entry point

  const appendStaticItem = useCallback((item: TUIDisplayItem) => {
    setTranscript((prev) => appendStaticTranscriptItem(prev, item))
  }, [])

  const resetTranscript = useCallback((items: TUIDisplayItem[] = []) => {
    setTranscript(createTranscriptState(items))
    setTranscriptGeneration((value) => value + 1)
  }, [])

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
      appendStaticItem(userMsg)

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
      setSpinnerSubText(undefined)

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
          const restored = await tryRestoreInterruptedPrompt({
            signal: ac.signal,
            store,
            sessionId: session.id,
            userMessageId: messageId,
            input,
            loop,
            resetTranscript,
            setTaskSnapshot,
            onRestoreInput,
          })
          if (restored) return

          const interruptMsg: TUIDisplayItem = {
            kind: 'system',
            id: randomUUID(),
            content: await formatInterruptMessage(store, session.id, messageId),
            createdAt: new Date().toISOString(),
          }
          appendStaticItem(interruptMsg)
        } else {
          const errorMsg: TUIDisplayItem = {
            kind: 'error',
            id: randomUUID(),
            content: err instanceof Error ? err.message : String(err),
            createdAt: new Date().toISOString(),
          }
          appendStaticItem(errorMsg)
        }
      } finally {
        onActiveModelChange?.(loop.getActiveModel())
        setIsStreaming(false)
        abortControllerRef.current = null
        lastToolUseIdRef.current.clear()
        activeToolProgressRef.current.clear()
        subagentProgressRef.current.clear()
        setSpinnerSubText(undefined)
        setTranscript((prev) => clearToolProgress(prev))
      }
    },
    [loop, store, session.id, onActiveModelChange, appendStaticItem, onRestoreInput, resetTranscript],
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
    setTranscript((prev) => applyToolProgressToTranscriptState(prev, {
      listContent,
      subagentProgressByAgentId: subagentProgressRef.current,
    }))
  }, [])

  // Handle records from ToolRunner (via onRecord callback)
  const handleRecord = useCallback(
    (record: SessionRecord) => {
      // Update display items based on record type
      // Note: persistence is handled by loop.appendRecord, not here
      if (record.type === 'tool_use' && !isHiddenToolCall(record.tool)) {
        // Track tool name -> tool_use ID mapping for approval matching
        lastToolUseIdRef.current.set(record.tool, record.id)

        setTranscript((prev) => applyTuiRecordToTranscriptState(prev, record))
      } else if (record.type === 'tool_approval' && !isHiddenToolCall(record.tool)) {
        // Match approval to tool_use by looking up the most recent tool_use ID for this tool name
        const toolUseId = lastToolUseIdRef.current.get(record.tool)
        setTranscript((prev) => applyTuiRecordToTranscriptState(prev, record, {
          approvalToolUseId: toolUseId,
        }))
      } else if (record.type === 'tool_result') {
        if (record.display?.taskSnapshot) {
          setTaskSnapshot(record.display.taskSnapshot)
          if (activeToolProgressRef.current.size === 0) {
            setSpinnerSubText(undefined)
          }
        }
        if (!isHiddenToolCall(record.tool)) {
          setTranscript((prev) => applyTuiRecordToTranscriptState(prev, record))
        }
      } else if (record.type === 'message' && record.role === 'assistant') {
        setTranscript((prev) => {
          if (prev.staticItems.some((item) => item.kind === 'assistant' && item.id === record.id)) return prev
          return applyTuiRecordToTranscriptState(prev, record)
        })
      } else if (record.type === 'compact_boundary') {
        setTranscript((prev) => applyTuiRecordToTranscriptState(prev, record))
      } else if (record.type === 'compact_attempt_failed') {
        setTranscript((prev) => applyTuiRecordToTranscriptState(prev, record))
      } else if (record.type === 'subagent_task') {
        setTranscript((prev) => applyTuiRecordToTranscriptState(prev, record, {
          subagentProgress: subagentProgressRef.current.get(record.agentId),
        }))
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

  const interrupt = useCallback((reason: unknown = 'user-cancel') => {
    onInterrupt?.()
    abortControllerRef.current?.abort(reason)
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
    const latestTaskSnapshot = findLatestTaskSnapshot(loaded.records)
    setTaskSnapshot(latestTaskSnapshot)
    resetTranscript([...systemItems, ...recordsToDisplayItems(loaded.records)])
    return loaded.records
  }, [store, session.id, resetTranscript])

  return {
    staticTranscriptItems: transcript.staticItems,
    liveItems: transcript.liveItems,
    recentCompletedToolCall: transcript.recentCompletedToolCall,
    transcriptGeneration,
    appendStaticItem,
    resetTranscript,
    isStreaming,
    spinnerSubText,
    taskSnapshot,
    usage,
    submit,
    interrupt,
    reloadMessages,
  }
}

async function tryRestoreInterruptedPrompt(input: {
  signal: AbortSignal
  store: SessionStore
  sessionId: string
  userMessageId: string
  input: string
  loop: AgentLoop
  resetTranscript: (items?: TUIDisplayItem[]) => void
  setTaskSnapshot: (snapshot: TaskDisplaySnapshot | undefined) => void
  onRestoreInput?: (text: string) => void
}): Promise<boolean> {
  if (input.signal.reason !== 'user-cancel') return false

  try {
    const records = await rollbackInterruptedPromptIfSynthetic({
      store: input.store,
      sessionId: input.sessionId,
      userMessageId: input.userMessageId,
    })
    if (!records) return false

    input.loop.invalidateRecordsCache()
    input.setTaskSnapshot(findLatestTaskSnapshot(records))
    input.resetTranscript(recordsToDisplayItems(records))
    input.onRestoreInput?.(input.input)
    return true
  } catch {
    return false
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

function findLatestTaskSnapshot(records: readonly SessionRecord[]): TaskDisplaySnapshot | undefined {
  for (const record of [...records].reverse()) {
    if (record.type !== 'tool_result') continue
    if (record.display?.taskSnapshot) return record.display.taskSnapshot
  }
  return undefined
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
