import { useState, useCallback, useRef, useEffect, useSyncExternalStore } from 'react'
import { randomUUID } from 'node:crypto'
import type { ActiveModelRuntime, AgentRunOverrides } from '../../harness/loop.js'
import type {
  ModelPricing,
  SessionRecord,
  ModelStreamEvent,
  TokenUsage,
} from '../../harness/types.js'
import type { TUIDisplayItem } from '../types.js'
import type { SessionController, SessionEvent } from '../../runtime/sessionController.js'
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
  controller: SessionController
  existingRecords: SessionRecord[]
  initialSystemMessages?: TUIDisplayItem[]
  pricing?: ModelPricing
  onRecordExternal?: (record: SessionRecord) => void
  onActiveModelChange?: (model: Omit<ActiveModelRuntime, 'provider'>) => void
  onInterrupt?: () => void
  onRestoreInput?: (text: string) => void
}

/**
 * Renders a {@link SessionController} into Ink.
 *
 * Everything here is terminal-specific: the static/live transcript split that
 * exists only because Ink's `<Static>` output cannot be retracted, the
 * `<Static>` remount key, the spinner phase machine, and the imperative
 * elapsed-time counters the spinner samples every frame. The turn lifecycle
 * itself lives in the controller — this hook only reacts to its event stream.
 */
export function useAgentLoop({
  controller,
  existingRecords,
  initialSystemMessages = [],
  pricing,
  onRecordExternal,
  onActiveModelChange,
  onInterrupt,
  onRestoreInput,
}: UseAgentLoopOptions) {
  const [transcript, setTranscript] = useState<TuiTranscriptState>(() =>
    createTranscriptState([...initialSystemMessages, ...recordsToDisplayItems(existingRecords)]),
  )
  const [transcriptGeneration, setTranscriptGeneration] = useState(0)
  const [streamMode, setStreamMode] = useState<StreamDisplayMode>('requesting')

  const { isStreaming, usage, taskSnapshot, spinnerSubText } = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  )

  // Elapsed-time accounting for the spinner. loadingStartTimeRef is anchored at
  // turn start; totalPausedMsRef accumulates overlay/pause time strobed in by
  // the Spinner's active toggle; pauseStartTimeRef freezes the elapsed clock
  // while the spinner is hidden. All four are sampled imperatively every frame,
  // so they stay refs rather than joining the controller snapshot.
  const responseLengthRef = useRef(0)
  const loadingStartTimeRef = useRef(0)
  const totalPausedMsRef = useRef(0)
  const pauseStartTimeRef = useRef<number | null>(null)

  const thinkingStartRef = useRef<number | null>(null)
  const thinkingDurationRef = useRef<number | null>(null)
  const thinkingTextAccRef = useRef('')
  const thinkingPreviewDoneRef = useRef(false)
  const streamingThinkingIdRef = useRef<string | null>(null)

  const appendStaticItem = useCallback((item: TUIDisplayItem) => {
    setTranscript((prev) => appendStaticTranscriptItem(prev, item))
  }, [])

  const resetTranscript = useCallback((items: TUIDisplayItem[] = []) => {
    setTranscript(createTranscriptState(items))
    setTranscriptGeneration((value) => value + 1)
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

  const applyRecord = useCallback((event: Extract<SessionEvent, { type: 'record' }>) => {
    const record = event.record
    if (record.type === 'tool_use') {
      if (isHiddenToolCall(record.tool)) {
        setTranscript((prev) => markToolGroupBoundary(prev))
      } else {
        setTranscript((prev) => applyTuiRecordToTranscriptState(prev, record))
      }
    } else if (record.type === 'tool_approval' && !isHiddenToolCall(record.tool)) {
      setTranscript((prev) => applyTuiRecordToTranscriptState(prev, record, {
        approvalToolUseId: event.approvalToolUseId,
      }))
    } else if (record.type === 'tool_result') {
      if (isHiddenToolCall(record.tool)) {
        // Hidden tools (TaskCreate, TaskUpdate, EnterPlanMode, etc.) don't have
        // a visible tool_call in liveItems, but preceding user messages and
        // thinking blocks still have to be committed to static to preserve
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
    } else if (record.type === 'compact_boundary' || record.type === 'compact_attempt_failed') {
      setTranscript((prev) => applyTuiRecordToTranscriptState(prev, record))
    } else if (record.type === 'subagent_task') {
      setTranscript((prev) => applyTuiRecordToTranscriptState(prev, record, {
        subagentProgress: event.subagentProgress,
      }))
    }
  }, [])

  const handleEvent = useCallback((event: SessionEvent) => {
    switch (event.type) {
      case 'turn-start': {
        // Move any live items (e.g. thinking blocks from the previous turn) to
        // static first, then place the user message in liveItems — never static —
        // so a rollback can remove it without leaving a scrollback ghost.
        setTranscript((prev) => commitLiveItemsToStatic(prev))
        const userMsg: TUIDisplayItem = {
          kind: 'user',
          id: event.messageId,
          content: event.displayInput,
          createdAt: event.createdAt,
        }
        setTranscript((prev) => ({ ...prev, liveItems: [...prev.liveItems, userMsg] }))
        setStreamMode('requesting')
        responseLengthRef.current = 0
        loadingStartTimeRef.current = Date.now()
        totalPausedMsRef.current = 0
        pauseStartTimeRef.current = null
        thinkingStartRef.current = null
        thinkingDurationRef.current = null
        return
      }
      case 'record':
        applyRecord(event)
        onRecordExternal?.(event.record)
        return
      case 'tool-progress':
        setTranscript((prev) => applyToolProgressToTranscriptState(prev, {
          ...(event.listContent !== undefined ? { listContent: event.listContent } : {}),
          subagentProgressByAgentId: controller.getSubagentProgress(),
        }))
        return
      case 'stream':
        handleStreamEvent(event.event)
        return
      case 'notice':
        appendStaticItem({
          kind: event.level === 'error' ? 'error' : 'system',
          id: randomUUID(),
          content: event.content,
          createdAt: new Date().toISOString(),
        })
        return
      case 'transcript-reset': {
        const systemItems: TUIDisplayItem[] = event.systemMessages.map((content) => ({
          kind: 'system',
          id: randomUUID(),
          content,
          createdAt: new Date().toISOString(),
        }))
        const items = [...systemItems, ...recordsToDisplayItems([...event.records])]
        // A rollback rebuilds the same conversation and must not bump the
        // generation, or Ink remounts every `<Static>` row and repaints.
        if (event.bumpGeneration) resetTranscript(items)
        else setTranscript(createTranscriptState(items))
        return
      }
      case 'session-meta':
        // The terminal reads the title off the controller when it draws it, so
        // the `publish()` that came with this event is the whole update. Nothing
        // belongs in the transcript.
        return
      case 'restore-input':
        onRestoreInput?.(event.text)
        return
      case 'active-model':
        onActiveModelChange?.(event.model)
        return
      case 'turn-end': {
        if (!event.aborted) {
          // Commit ALL live items to static (including thinking-bearing
          // messages) so the dynamic frame never exceeds viewport height.
          // Ctrl+O expansion is handled by MessageList's fallback rendering.
          setTranscript((prev) => commitAllLiveItemsToStatic(prev))
          // Appended to liveSystemItems so the duration renders AFTER thinking
          // blocks, not before them; it commits to static on the next turn.
          setTranscript((prev) => appendLiveSystemItem(prev, {
            kind: 'system',
            id: randomUUID(),
            content: formatWorkedSummary(formatDuration(event.durationMs), event.usage, pricing),
            createdAt: new Date().toISOString(),
          }))
        }
        setStreamMode('requesting')
        // Clear live items only on a rollback abort (user message ghost
        // prevention). Otherwise they transition to static naturally at the
        // start of the next turn.
        if (event.rolledBack) {
          setTranscript((prev) => prev.liveItems.length > 0 ? { ...prev, liveItems: [] } : prev)
        }
        return
      }
    }
  }, [
    controller,
    applyRecord,
    appendStaticItem,
    resetTranscript,
    handleStreamEvent,
    onActiveModelChange,
    onRecordExternal,
    onRestoreInput,
    pricing,
  ])

  useEffect(() => controller.onEvent(handleEvent), [controller, handleEvent])

  const submit = useCallback(
    (input: string, options?: AgentRunOverrides) => controller.submit(input, options),
    [controller],
  )

  const interrupt = useCallback((reason: unknown = 'user-cancel') => {
    onInterrupt?.()
    controller.interrupt(reason)
  }, [controller, onInterrupt])

  /** Reloads the session from disk (e.g. after truncation) and rebuilds the view. */
  const reloadMessages = useCallback(() => controller.reload(), [controller])

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

function formatDuration(durationMs: number): string {
  const totalSec = Math.floor(durationMs / 1000)
  const min = Math.floor(totalSec / 60)
  const sec = totalSec % 60
  return min > 0 ? `${min}m ${sec}s` : `${sec}s`
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
