import { useState, useCallback, useRef, useEffect } from 'react'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createProvider } from '../../config/providers.js'
import { SessionStore } from '../../sessions/service.js'
import { getAllTools } from '../../tools/index.js'
import { SkillsService } from '../../services/skills/skillsService.js'
import { PermissionGate } from '../../harness/permissions.js'
import { ToolRunner } from '../../harness/toolRunner.js'
import { ContextBuilder } from '../../harness/contextBuilder.js'
import { AgentLoop } from '../../harness/loop.js'
import { formatUsageLine } from '../../harness/usage.js'
import { getProjectContext } from '../../services/context/projectContext.js'
import { registerBuiltinCommands, getCommand } from '../../commands/index.js'
import { setRunning, setStreaming, setError, setStartTime, setCurrentModel } from '../state/appState.js'
import type { Config, ModelConfig } from '../../config/service.js'
import type { SessionMeta } from '../../sessions/service.js'
import type { AgentRunResult, AgentStreamEvent, SessionRecord, TokenUsage } from '../../harness/types.js'

import type { MessageRole, DisplayMessage } from '../types.js'
export type { MessageRole, DisplayMessage }

import type { PermissionPrompt } from '../../harness/permissions.js'

interface UseSessionReturn {
  messages: DisplayMessage[]
  isRunning: boolean
  startTime: string | null
  streamingText: string
  streamingMessageId: string | null
  error: string | null
  query: (input: string) => Promise<void>
  abort: () => void
  clearMessages: () => void
  sessionId: string | null
}

function sessionRecordToDisplay(record: SessionRecord): DisplayMessage | null {
  if (record.type === 'message') {
    return {
      id: record.id,
      role: record.role as MessageRole,
      content: record.content,
      createdAt: record.createdAt,
    }
  }
  if (record.type === 'tool_use') {
    return {
      id: `${record.id}-use`,
      role: 'tool_use',
      content: '',
      toolName: record.tool,
      toolInput: record.input,
      createdAt: record.createdAt,
    }
  }
  if (record.type === 'tool_result') {
    return {
      id: `${record.toolUseId}-result`,
      role: 'tool_result',
      content: record.content,
      toolName: record.tool,
      toolOk: record.ok,
      createdAt: record.createdAt,
    }
  }
  return null
}

export function useSession(config: Config, cwd: string, resumeSessionId?: string, requestPermission?: PermissionPrompt): UseSessionReturn {
  // Local state (high-frequency updates)
  const [messages, setMessages] = useState<DisplayMessage[]>([])
  const [sessionId, setSessionId] = useState<string | null>(null)

  // Refs for execution state
  const abortControllerRef = useRef<AbortController | null>(null)
  const loopRef = useRef<AgentLoop | null>(null)
  const storeRef = useRef<SessionStore | null>(null)
  const sessionRef = useRef<SessionMeta | null>(null)
  const modelConfigRef = useRef<ModelConfig | null>(null)
  const streamBufferRef = useRef('')
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const requestPermissionRef = useRef(requestPermission)
  requestPermissionRef.current = requestPermission

  // Usage accumulator
  const usageRef = useRef({ inputTokens: 0, outputTokens: 0, cost: 0 })

  // Initialize session on mount
  useEffect(() => {
    let cancelled = false

    async function init() {
      const modelConfig = config.defaultModel ? config.models[config.defaultModel] : undefined
      if (!modelConfig) {
        setError('No default model configured')
        return
      }
      modelConfigRef.current = modelConfig
      setCurrentModel(modelConfig.model)

      const provider = createProvider(modelConfig)
      if (!provider) {
        setError(`Failed to create provider: ${modelConfig.provider}`)
        return
      }

      const store = new SessionStore(cwd)
      await store.init()
      storeRef.current = store

      let session: SessionMeta
      if (resumeSessionId) {
        const existing = await store.resolve(resumeSessionId)
        if (!existing) {
          setError(`Session not found: ${resumeSessionId}`)
          return
        }
        session = existing
      } else {
        session = await store.create()
      }
      sessionRef.current = session
      setSessionId(session.id)

      const tools = await getAllTools(cwd)
      const skills = await new SkillsService(cwd).list()
      const contextManagement = config.agent.contextManagement
      const isGitRepo = existsSync(join(cwd, '.git'))
      const projectContext = await getProjectContext(cwd)

      // Register built-in commands
      registerBuiltinCommands()

      const permissionGate = new PermissionGate(
        requestPermissionRef.current ?? (async () => true),
      )
      const toolRunner = new ToolRunner(tools, permissionGate, {
        onRecord: async (record) => {
          await store.appendRecord(session.id, record)
          const display = sessionRecordToDisplay(record)
          if (display) {
            setMessages((prev) => [...prev, display])
          }
        },
      })

      const loop = new AgentLoop({
        provider,
        model: modelConfig.model,
        tools,
        contextBuilder: new ContextBuilder(undefined, contextManagement),
        toolRunner,
        toolContext: {
          cwd,
          sessionId: session.id,
          readFiles: new Set(),
          readFileState: new Map(),
          invokedSkills: new Map(),
          taskState: new Map(),
        },
        system: config.agent.system,
        projectContext,
        skills,
        promptCacheRetention: modelConfig.promptCacheRetention,
        contextManagement,
        isGitRepo,
        loadRecords: async () => store.loadRecords(session.id),
        appendRecord: async (record) => store.appendRecord(session.id, record),
      })
      loopRef.current = loop

      // Load existing records for resumed sessions
      if (resumeSessionId) {
        const records = await store.loadRecords(session.id)
        const displayMessages = records
          .map(sessionRecordToDisplay)
          .filter((m): m is DisplayMessage => m !== null)
        if (!cancelled) {
          setMessages(displayMessages)
        }
      }
    }

    init().catch((err) => {
      if (!cancelled) {
        setError(err.message ?? String(err))
      }
    })

    return () => { cancelled = true }
  }, [config, cwd, resumeSessionId])

  const flushStreamBuffer = useCallback(() => {
    if (flushTimerRef.current) {
      clearTimeout(flushTimerRef.current)
      flushTimerRef.current = null
    }
    const msgId = streamingMessageIdRef.current
    setStreaming(streamBufferRef.current, msgId)
    // Also update the placeholder message content
    if (msgId) {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === msgId ? { ...m, content: streamBufferRef.current } : m,
        ),
      )
    }
  }, [])

  const streamingMessageIdRef = useRef<string | null>(null)

  const query = useCallback(async (input: string) => {
    if (!loopRef.current || !storeRef.current || !sessionRef.current || !modelConfigRef.current) {
      setError('Session not initialized')
      return
    }

    // Check for slash commands
    if (input.startsWith('/')) {
      const [cmdName, ...argsParts] = input.slice(1).split(' ')
      const command = getCommand(cmdName)
      if (command) {
        const lines: string[] = []
        const context = {
          cwd,
          sessionId: sessionRef.current?.id ?? '',
          writeLine: (msg: string) => lines.push(msg),
          clearMessages: () => {
            setMessages([])
            setError(null)
          },
          getUsage: () => usageRef.current,
          getModel: () => modelConfigRef.current?.model ?? 'unknown',
          setModel: (model: string) => {
            if (modelConfigRef.current) {
              modelConfigRef.current = { ...modelConfigRef.current, model }
              setCurrentModel(model)
            }
          },
        }
        await command.run(argsParts.join(' '), context)
        if (lines.length > 0) {
          setMessages((prev) => [
            ...prev,
            {
              id: crypto.randomUUID(),
              role: 'system' as const,
              content: lines.join('\n'),
              createdAt: new Date().toISOString(),
            },
          ])
        }
        return
      }
    }

    setRunning(true)
    setStartTime(new Date().toISOString())
    setError(null)
    setStreaming('', null)
    streamBufferRef.current = ''

    // Add user message to display immediately
    const userMsg: DisplayMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: input,
      createdAt: new Date().toISOString(),
    }

    // Create placeholder assistant message for streaming
    const assistantMsgId = crypto.randomUUID()
    streamingMessageIdRef.current = assistantMsgId
    setStreaming('', assistantMsgId)

    const placeholderMsg: DisplayMessage = {
      id: assistantMsgId,
      role: 'assistant',
      content: '',
      createdAt: new Date().toISOString(),
    }

    setMessages((prev) => [...prev, userMsg, placeholderMsg])

    const abortController = new AbortController()
    abortControllerRef.current = abortController

    const onEvent = (event: AgentStreamEvent) => {
      if (event.type === 'text_delta') {
        streamBufferRef.current = event.snapshot
        // Throttle React state updates to ~50ms
        if (!flushTimerRef.current) {
          flushTimerRef.current = setTimeout(() => {
            flushTimerRef.current = null
            setStreaming(streamBufferRef.current, assistantMsgId)
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantMsgId ? { ...m, content: streamBufferRef.current } : m,
              ),
            )
          }, 50)
        }
      }
    }

    try {
      const result: AgentRunResult = await loopRef.current.run(input, abortController.signal, onEvent)

      // Flush any remaining buffered text
      flushStreamBuffer()

      // Finalize the streaming message with the complete content
      if (result.content) {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantMsgId ? { ...m, content: result.content } : m,
          ),
        )
      } else {
        // If no content, remove the placeholder
        setMessages((prev) => prev.filter((m) => m.id !== assistantMsgId))
      }

      // Add usage line as system message
      const usageLine = formatUsageLine(result.usage, modelConfigRef.current.pricing)
      const usageMsg: DisplayMessage = {
        id: crypto.randomUUID(),
        role: 'system',
        content: usageLine,
        createdAt: new Date().toISOString(),
      }
      setMessages((prev) => [...prev, usageMsg])

      // Accumulate usage
      if (result.usage) {
        const pricing = modelConfigRef.current.pricing
        const inputCost = (result.usage.inputTokens / 1_000_000) * (pricing?.inputPerMillionTokens ?? 0)
        const outputCost = (result.usage.outputTokens / 1_000_000) * (pricing?.outputPerMillionTokens ?? 0)
        usageRef.current = {
          inputTokens: usageRef.current.inputTokens + result.usage.inputTokens,
          outputTokens: usageRef.current.outputTokens + result.usage.outputTokens,
          cost: usageRef.current.cost + inputCost + outputCost,
        }
      }
    } catch (err: unknown) {
      const e = err as { name?: string; message?: string }
      if (e.name === 'AbortError') {
        // Keep whatever was streamed so far
        flushStreamBuffer()
        const abortMsg: DisplayMessage = {
          id: crypto.randomUUID(),
          role: 'system',
          content: '[Interrupted]',
          createdAt: new Date().toISOString(),
        }
        setMessages((prev) => [...prev, abortMsg])
      } else {
        // Remove the empty placeholder on error
        setMessages((prev) => prev.filter((m) => m.id !== assistantMsgId))
        setError(e.message ?? String(err))
      }
    } finally {
      if (flushTimerRef.current) {
        clearTimeout(flushTimerRef.current)
        flushTimerRef.current = null
      }
      setRunning(false)
      setStartTime(null)
      setStreaming('', null)
      streamingMessageIdRef.current = null
      streamBufferRef.current = ''
      abortControllerRef.current = null
    }
  }, [flushStreamBuffer])

  const abort = useCallback(() => {
    abortControllerRef.current?.abort()
  }, [])

  const clearMessages = useCallback(() => {
    setMessages([])
    setError(null)
  }, [])

  return {
    messages,
    isRunning: false, // Will be read from appStore in components
    startTime: null,
    streamingText: '',
    streamingMessageId: null,
    error: null,
    query,
    abort,
    clearMessages,
    sessionId,
  }
}
