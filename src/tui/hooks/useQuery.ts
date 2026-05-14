import { useState, useCallback, useRef, useEffect } from 'react'
import { createProvider } from '../../config/providers.js'
import { SessionStore } from '../../sessions/service.js'
import { AgentLoop } from '../../harness/loop.js'
import { PermissionGate } from '../../harness/permissions.js'
import { ToolRunner } from '../../harness/toolRunner.js'
import { ContextBuilder } from '../../harness/contextBuilder.js'
import type { Config } from '../../config/service.js'
import type { AgentRunResult, AgentStreamEvent } from '../../harness/types.js'

export class AbortError extends Error {
  constructor() {
    super('Aborted')
    this.name = 'AbortError'
  }
}

export function useQuery(
  config: Config,
  cwd: string,
  sessionId: string | null,
  store: SessionStore | null,
) {
  const loopRef = useRef<AgentLoop | null>(null)
  const abortControllerRef = useRef<AbortController | null>(null)
  const [isRunning, setIsRunning] = useState(false)

  useEffect(() => {
    if (!sessionId || !store) return

    let cancelled = false

    async function init() {
      const session = await store!.resolve(sessionId!)
      if (!session || cancelled) return

      const modelConfig = config.defaultModel ? config.models[config.defaultModel] : undefined
      if (!modelConfig || cancelled) return

      const provider = createProvider(modelConfig)
      if (!provider || cancelled) return

      const permissionGate = new PermissionGate(async () => true)
      const toolRunner = new ToolRunner([], permissionGate, {
        onRecord: async () => {},
      })
      const contextBuilder = new ContextBuilder(undefined, config.agent.contextManagement)
      const loop = new AgentLoop({
        provider,
        model: modelConfig.model,
        tools: [],
        contextBuilder,
        toolRunner,
        toolContext: {
          cwd,
          sessionId: sessionId!,
          readFiles: new Set(),
          readFileState: new Map(),
          invokedSkills: new Map(),
          taskState: new Map(),
        },
        system: config.agent.system,
        contextManagement: config.agent.contextManagement,
        loadRecords: async () => store!.loadRecords(sessionId!),
        appendRecord: async () => {},
      })

      if (!cancelled) {
        loopRef.current = loop
      }
    }

    init()

    return () => {
      cancelled = true
      abortControllerRef.current?.abort()
      loopRef.current = null
    }
  }, [config, cwd, sessionId, store])

  const executeQuery = useCallback(async (
    input: string,
    onEvent: (event: AgentStreamEvent) => void,
  ): Promise<AgentRunResult | { interrupted: true } | undefined> => {
    if (!loopRef.current || !sessionId || !store) return

    const controller = new AbortController()
    abortControllerRef.current = controller
    setIsRunning(true)

    try {
      const result = await loopRef.current.run(
        input,
        controller.signal,
        onEvent,
      )
      return result
    } catch (error) {
      if (error instanceof AbortError) {
        return { interrupted: true as const }
      }
      throw error
    } finally {
      setIsRunning(false)
      abortControllerRef.current = null
    }
  }, [sessionId, store])

  const abort = useCallback(() => {
    abortControllerRef.current?.abort()
  }, [])

  return {
    executeQuery,
    abort,
    isRunning,
  }
}
