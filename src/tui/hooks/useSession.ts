import { useCallback, useEffect } from 'react'
import { useSessionManager } from './useSessionManager.js'
import { useMessageManager } from './useMessageManager.js'
import { useQuery } from './useQuery.js'
import { registerBuiltinCommands, getCommand } from '../../commands/index.js'
import { setCurrentModel, setError } from '../state/appState.js'
import { formatUsageLine } from '../../harness/usage.js'
import type { Config } from '../../config/service.js'
import type { AgentStreamEvent } from '../../harness/types.js'

export type { DisplayMessage, MessageRole } from '../types.js'

interface UseSessionReturn {
  messages: ReturnType<typeof useMessageManager>['messages']
  isRunning: boolean
  query: (input: string) => Promise<void>
  abort: () => void
  clearMessages: () => void
  sessionId: string | null
}

export function useSession(config: Config, cwd: string, resumeSessionId?: string): UseSessionReturn {
  const { sessionId, sessionMeta, store, error: sessionError } = useSessionManager(cwd, resumeSessionId)

  const {
    messages,
    addUserMessage,
    addAssistantPlaceholder,
    appendStreamText,
    finalizeAssistantMessage,
    addToolMessage,
    addSystemMessage,
    clearMessages,
  } = useMessageManager()

  const { executeQuery, abort, isRunning } = useQuery(config, cwd, sessionId, store)

  // Register commands and set model on initialization
  useEffect(() => {
    registerBuiltinCommands()

    const modelConfig = config.defaultModel ? config.models[config.defaultModel] : undefined
    if (modelConfig) {
      setCurrentModel(modelConfig.model)
    }
  }, [config])

  // Set error from session manager
  useEffect(() => {
    if (sessionError) {
      setError(sessionError)
    }
  }, [sessionError])

  const query = useCallback(async (input: string) => {
    if (!sessionId || !store) {
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
          sessionId,
          writeLine: (msg: string) => lines.push(msg),
          clearMessages: () => {
            clearMessages()
            setError(null)
          },
          getModel: () => config.defaultModel ?? 'unknown',
          setModel: (model: string) => {
            setCurrentModel(model)
          },
        }
        await command.run(argsParts.join(' '), context)
        if (lines.length > 0) {
          addSystemMessage(lines.join('\n'))
        }
        return
      }
    }

    // Add user message and placeholder
    addUserMessage(input)
    addAssistantPlaceholder()

    // Execute query with streaming
    const result = await executeQuery(input, (event: AgentStreamEvent) => {
      if (event.type === 'text_delta') {
        appendStreamText(event.delta)
      }
    })

    if (!result) {
      return
    }

    // Handle interrupted
    if ('interrupted' in result && result.interrupted) {
      addSystemMessage('[Interrupted]', 'warning')
      return
    }

    // Handle successful result
    if ('content' in result) {
      finalizeAssistantMessage(result.content)

      // Add usage line
      const modelConfig = config.defaultModel ? config.models[config.defaultModel] : undefined
      if (result.usage && modelConfig) {
        const usageLine = formatUsageLine(result.usage, modelConfig.pricing)
        addSystemMessage(usageLine, 'info')
      }
    }
  }, [
    sessionId,
    store,
    cwd,
    config,
    addUserMessage,
    addAssistantPlaceholder,
    appendStreamText,
    finalizeAssistantMessage,
    addSystemMessage,
    clearMessages,
    executeQuery,
  ])

  return {
    messages,
    isRunning,
    query,
    abort,
    clearMessages,
    sessionId,
  }
}
