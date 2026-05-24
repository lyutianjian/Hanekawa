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
}: UseAgentLoopOptions) {
  const [messages, setMessages] = useState<TUIDisplayItem[]>(() =>
    [...initialSystemMessages, ...recordsToDisplayItems(existingRecords)],
  )
  const [isStreaming, setIsStreaming] = useState(false)
  const [usage, setUsage] = useState<TUIUsage>({
    current: null,
    total: createEmptyUsage(),
  })

  const abortControllerRef = useRef<AbortController | null>(null)
  // Track the most recent tool_use ID for each tool name (for approval matching)
  const lastToolUseIdRef = useRef<Map<string, string>>(new Map())
  const activeToolProgressRef = useRef<Map<string, ToolProgressEvent['call']>>(new Map())

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
      current: null,
      total: createEmptyUsage(),
    })
    lastToolUseIdRef.current.clear()
    activeToolProgressRef.current.clear()
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
          current: result.usage,
          total: addTokenUsage(prev.total, result.usage),
        }))
      } catch (err: unknown) {
        if (err instanceof Error && (err.name === 'AbortError' || (err as Error & { aborted?: boolean }).aborted)) {
          const interruptMsg: TUIDisplayItem = {
            kind: 'system',
            id: randomUUID(),
            content: 'Interrupted.',
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
        setMessages((prev) => prev.filter((item) => item.kind !== 'tool_progress'))
      }
    },
    [loop, store, session.id, onActiveModelChange],
  )

  const handleProgress = useCallback((event: ToolProgressEvent) => {
    if (event.phase === 'started') {
      activeToolProgressRef.current.set(event.call.id, event.call)
    } else {
      activeToolProgressRef.current.delete(event.call.id)
    }

    const content = formatToolProgress([...activeToolProgressRef.current.values()])
    setMessages((prev) => {
      const withoutProgress = prev.filter((item) => item.kind !== 'tool_progress')
      if (!content) return withoutProgress
      return [
        ...withoutProgress,
        {
          kind: 'tool_progress' as const,
          id: 'tool-progress',
          content,
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
      if (record.type === 'tool_use') {
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
      } else if (record.type === 'tool_approval') {
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
      } else if (record.type === 'tool_result') {
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
    abortControllerRef.current?.abort()
  }, [])

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
    usage,
    submit,
    interrupt,
    handleRecord,
    reloadMessages,
  }
}

function formatToolProgress(calls: Array<ToolProgressEvent['call']>): string | undefined {
  if (calls.length <= 1) return undefined

  const counts = new Map<string, number>()
  for (const call of calls) {
    counts.set(call.name, (counts.get(call.name) ?? 0) + 1)
  }

  if (counts.size === 1) {
    const name = calls[0]?.name
    if (name === 'Read') return `Reading ${calls.length} files in parallel...`
    return `Running ${calls.length} ${formatToolName(name)} calls in parallel...`
  }

  return `Running ${calls.length} tools in parallel...`
}

function formatToolName(toolName: string | undefined): string {
  if (!toolName) return 'tool'
  return toolName
}

// Convert SessionRecord[] to TUIDisplayItem[] for initial display
export function recordsToDisplayItems(records: SessionRecord[]): TUIDisplayItem[] {
  const items: TUIDisplayItem[] = []

  for (const record of records) {
    if (record.type === 'message') {
      items.push({
        kind: record.role === 'user' ? 'user' : record.role === 'assistant' ? 'assistant' : 'system',
        id: record.id,
        content: record.content,
        createdAt: record.createdAt,
      })
    } else if (record.type === 'tool_use') {
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
      // Find the matching tool_call and attach the result
      const matchingCall = items.find(
        (i) => i.kind === 'tool_call' && i.toolUseId === record.toolUseId,
      )
      if (matchingCall && matchingCall.kind === 'tool_call') {
        matchingCall.result = record.content
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
    }
  }

  return items
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
