import { useState, useCallback, useRef, useEffect } from 'react'
import { randomUUID } from 'node:crypto'
import type { AgentLoop } from '../../harness/loop.js'
import type { ActiveModelRuntime, AgentRunOverrides } from '../../harness/loop.js'
import type { SessionStore } from '../../sessions/service.js'
import type { PermissionGate } from '../../harness/permissions.js'
import type { SessionMeta } from '../../sessions/service.js'
import type {
  AgentRunResult,
  ModelPricing,
  SessionRecord,
  ModelStreamEvent,
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
  appendLiveSystemItem,
  appendStaticTranscriptItem,
  applyStreamingThinkingPreview,
  applyToolProgressToTranscriptState,
  applyTuiRecordToTranscriptState,
  commitAllLiveItemsToStatic,
  commitLiveItemsToStatic,
  commitPrecedingLiveItemsToStatic,
  createTranscriptState,
  isHiddenToolCall,
  markToolGroupBoundary,
  recordsToDisplayItems,
  type TuiTranscriptState,
} from '../transcript.js'
import { rollbackInterruptedPromptIfSynthetic } from '../interruptRollback.js'
import { calculateTokenCost, hasCompletePricing } from '../../harness/usage.js'

export { isHiddenToolCall, recordsToDisplayItems } from '../transcript.js'

export type StreamDisplayMode =
  | 'requesting'
  | 'thinking'
  | 'tool-input'
  | 'tool-use'
  | 'responding'
  | 'waiting'

interface UseAgentLoopOptions {
  loop: AgentLoop
  store: SessionStore
  session: SessionMeta
  permissionGate: PermissionGate
  recordProxy: RecordProxy
  existingRecords: SessionRecord[]
  initialSystemMessages?: TUIDisplayItem[]
  pricing?: ModelPricing
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
  pricing,
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
    lastRequest: null,
    total: createEmptyUsage(),
  })
  const [spinnerSubText, setSpinnerSubText] = useState<string | undefined>()
  const [streamMode, setStreamMode] = useState<StreamDisplayMode>('requesting')
  const [taskSnapshot, setTaskSnapshot] = useState<TaskDisplaySnapshot | undefined>(() =>
    findLatestTaskSnapshot(existingRecords),
  )

  const abortControllerRef = useRef<AbortController | null>(null)
  // Track the most recent tool_use ID for each tool name (for approval matching)
  const lastToolUseIdRef = useRef<Map<string, string>>(new Map())
  const activeToolProgressRef = useRef<Map<string, ToolProgressEvent>>(new Map())
  const subagentProgressRef = useRef<Map<string, string>>(new Map())
  const responseLengthRef = useRef(0)
  // Elapsed-time accounting for the spinner. loadingStartTimeRef is anchored
  // in submit(); totalPausedMsRef accumulates overlay/pause time strobed in
  // by the Spinner's active toggle; pauseStartTimeRef freezes the elapsed
  // clock while the spinner is hidden.
  const loadingStartTimeRef = useRef(0)
  const totalPausedMsRef = useRef(0)
  const pauseStartTimeRef = useRef<number | null>(null)
  const thinkingStartRef = useRef<number | null>(null)
  const thinkingDurationRef = useRef<number | null>(null)
  const thinkingTextAccRef = useRef('')
  const thinkingPreviewDoneRef = useRef(false)
  const streamingThinkingIdRef = useRef<string | null>(null)

  // CheckpointService for creating snapshots before each user message
  const checkpointServiceRef = useRef<CheckpointService | null>(null)
  const checkpointInitializedRef = useRef(false)
  const didRollbackRef = useRef(false)
  const loopStartRef = useRef(0)

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
      lastRequest: null,
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
    async (input: string, options?: AgentRunOverrides) => {
      // Move any live items (e.g. thinking blocks from the previous turn) to static
      setTranscript((prev) => commitLiveItemsToStatic(prev))

      // Add user message — generate ID once, use everywhere.
      // Placed in liveItems first so rollback can cleanly remove it
      // without leaving a ghost in the terminal scrollback.
      const messageId = randomUUID()
      const userMsg: TUIDisplayItem = {
        kind: 'user',
        id: messageId,
        content: options?.displayInput ?? input,
        createdAt: new Date().toISOString(),
      }
      setTranscript((prev) => ({
        ...prev,
        liveItems: [...prev.liveItems, userMsg],
      }))

      setIsStreaming(true)
      setSpinnerSubText(undefined)
      setStreamMode('requesting')
      responseLengthRef.current = 0
      loadingStartTimeRef.current = Date.now()
      totalPausedMsRef.current = 0
      pauseStartTimeRef.current = null
      thinkingStartRef.current = null
      thinkingDurationRef.current = null

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

      const ac = new AbortController()
      abortControllerRef.current = ac
      didRollbackRef.current = false
      loopStartRef.current = Date.now()
      let completedResult: AgentRunResult | undefined

      try {
        const result = await loop.run(input, ac.signal, messageId, options)
        completedResult = result

        // Update usage
        setUsage((prev) => ({
          lastRequest: result.statusUsage ?? null,
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
            setTranscript,
            setTaskSnapshot,
            onRestoreInput,
          })
          if (restored) {
            didRollbackRef.current = true
            return
          }

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

        // Show duration summary on successful completion
        if (!ac.signal.aborted) {
          // Commit ALL live items to static (including thinking-bearing
          // messages) so the dynamic frame never exceeds viewport height.
          // Ctrl+O expansion is handled by MessageList's fallback rendering.
          setTranscript((prev) => commitAllLiveItemsToStatic(prev))

          const elapsed = Date.now() - loopStartRef.current
          const totalSec = Math.floor(elapsed / 1000)
          const min = Math.floor(totalSec / 60)
          const sec = totalSec % 60
          const duration = min > 0 ? `${min}m ${sec}s` : `${sec}s`
          const workedSummary = formatWorkedSummary(duration, completedResult?.usage, pricing)
          // Append to liveSystemItems so duration renders AFTER thinking
          // blocks (in live area), not before them (in static area).
          // Commits to static at the start of the next turn.
          setTranscript((prev) => appendLiveSystemItem(prev, {
            kind: 'system',
            id: randomUUID(),
            content: workedSummary,
            createdAt: new Date().toISOString(),
          }))
        }

        abortControllerRef.current = null
        lastToolUseIdRef.current.clear()
        activeToolProgressRef.current.clear()
        subagentProgressRef.current.clear()
        setSpinnerSubText(undefined)
        setStreamMode('requesting')
        // Clear live items only on rollback abort (user message ghost prevention).
        // On success or non-rollback abort, leave liveItems alone — they transition
        // to static naturally via commitLiveItemsToStatic at the start of the next submit.
        if (didRollbackRef.current) {
          setTranscript((prev) => prev.liveItems.length > 0 ? { ...prev, liveItems: [] } : prev)
        }
      }
    },
    [loop, store, session.id, onActiveModelChange, appendStaticItem, onRestoreInput, pricing],
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

  const handleStreamEvent = useCallback((event: ModelStreamEvent) => {
    switch (event.type) {
      case 'thinking_start':
        if (thinkingStartRef.current === null) thinkingStartRef.current = Date.now()
        thinkingTextAccRef.current = ''
        thinkingPreviewDoneRef.current = false
        streamingThinkingIdRef.current = `thinking-stream-${Date.now()}`
        setTranscript((prev) => applyStreamingThinkingPreview(prev, streamingThinkingIdRef.current!, undefined))
        setStreamMode('thinking')
        return
      case 'thinking_delta':
        if (thinkingStartRef.current === null) thinkingStartRef.current = Date.now()
        responseLengthRef.current += event.thinking.length
        thinkingTextAccRef.current += event.thinking
        if (!thinkingPreviewDoneRef.current) {
          const sentence = extractFirstSentence(thinkingTextAccRef.current)
          if (sentence) {
            thinkingPreviewDoneRef.current = true
            if (streamingThinkingIdRef.current) {
              setTranscript((prev) => applyStreamingThinkingPreview(prev, streamingThinkingIdRef.current!, sentence))
            }
          }
        }
        setStreamMode('thinking')
        return
      case 'redacted_thinking':
        if (thinkingStartRef.current === null) thinkingStartRef.current = Date.now()
        setStreamMode('thinking')
        return
      case 'thinking_stop':
        if (thinkingStartRef.current !== null) {
          thinkingDurationRef.current = Date.now() - thinkingStartRef.current
          thinkingStartRef.current = null
        }
        if (!thinkingPreviewDoneRef.current && thinkingTextAccRef.current && streamingThinkingIdRef.current) {
          const text = thinkingTextAccRef.current.trim()
          const preview = text.length > 80 ? text.slice(0, 80) + '…' : text || undefined
          setTranscript((prev) => applyStreamingThinkingPreview(prev, streamingThinkingIdRef.current!, preview))
        }
        setStreamMode('requesting')
        return
      case 'text_delta':
        responseLengthRef.current += event.text.length
        setStreamMode('responding')
        return
      case 'tool_input_delta':
        responseLengthRef.current += event.partialJson.length
        setStreamMode('tool-input')
        return
      case 'idle_warning':
        setStreamMode('waiting')
        return
      case 'message_start':
      case 'thinking_signature':
        setStreamMode('requesting')
        return
      case 'message_stop':
        // Model yielded control; tools execute (if any) until the next stream.
        setStreamMode('tool-use')
        return
      default:
        setStreamMode('responding')
        return
    }
  }, [])

  // Handle records from ToolRunner (via onRecord callback)
  const handleRecord = useCallback(
    (record: SessionRecord) => {
      // Update display items based on record type
      // Note: persistence is handled by loop.appendRecord, not here
      if (record.type === 'tool_use') {
        if (isHiddenToolCall(record.tool)) {
          setTranscript((prev) => markToolGroupBoundary(prev))
        } else {
          // Track tool name -> tool_use ID mapping for approval matching
          lastToolUseIdRef.current.set(record.tool, record.id)
          setTranscript((prev) => applyTuiRecordToTranscriptState(prev, record))
        }
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
        if (isHiddenToolCall(record.tool)) {
          // Hidden tools (TaskCreate, TaskUpdate, EnterPlanMode, etc.) don't
          // have a visible tool_call in liveItems, but we still need to commit
          // preceding user messages and thinking blocks to static to preserve
          // correct chronological ordering.
          setTranscript((prev) => commitPrecedingLiveItemsToStatic(prev))
        } else {
          setTranscript((prev) => applyTuiRecordToTranscriptState(prev, record))
        }
      } else if (record.type === 'message' && record.role === 'assistant') {
        setTranscript((prev) => {
          if (prev.staticItems.some((item) => item.kind === 'assistant' && item.id === record.id)) return prev
          return applyTuiRecordToTranscriptState(prev, record, {
            thinkingDurationMs: thinkingDurationRef.current ?? undefined,
          })
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
    recordProxy.setStreamEventHandler(handleStreamEvent)
    return () => {
      recordProxy.setHandler(() => {})
      recordProxy.setProgressHandler(() => {})
      recordProxy.setStreamEventHandler(() => {})
    }
  }, [recordProxy, handleRecord, handleProgress, handleStreamEvent])

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
    liveSystemItems: transcript.liveSystemItems,
    recentCompletedToolCall: transcript.recentCompletedToolCall,
    // Thinking-bearing messages are committed to static at turn end.
    // recentThinkingAssistant is maintained by commitAllLiveItemsToStatic
    // and appendStaticTranscriptItem, so Ctrl+O fallback works from static.
    recentThinkingAssistant: transcript.recentThinkingAssistant,
    transcriptGeneration,
    appendStaticItem,
    resetTranscript,
    isStreaming,
    spinnerSubText,
    streamMode,
    taskSnapshot,
    usage,
    responseLengthRef,
    loadingStartTimeRef,
    totalPausedMsRef,
    pauseStartTimeRef,
    submit,
    interrupt,
    reloadMessages,
  }
}

function extractFirstSentence(text: string): string | undefined {
  const match = text.match(/^(.+?[.!?。！？])[\s\n]/)
  if (match) return match[1].trim()
  if (text.length >= 80) return text.slice(0, 80) + '…'
  return undefined
}

async function tryRestoreInterruptedPrompt(input: {
  signal: AbortSignal
  store: SessionStore
  sessionId: string
  userMessageId: string
  input: string
  loop: AgentLoop
  setTranscript: React.Dispatch<React.SetStateAction<TuiTranscriptState>>
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
    input.setTranscript(createTranscriptState(recordsToDisplayItems(records)))
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

export function formatWorkedSummary(duration: string, usage: TokenUsage | undefined, pricing: ModelPricing | undefined): string {
  const base = `✻ Worked for ${duration}`
  if (!usage || !hasCompletePricing(pricing)) return base
  const currency = pricing.currency ?? 'USD'
  return `${base} · Cost: ${currency} ${formatCost(calculateTokenCost(usage, { ...pricing, currency }))}`
}

function formatCost(cost: number): string {
  if (cost === 0) return '0'
  if (cost < 0.000001) return cost.toExponential(4)
  return cost.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')
}
