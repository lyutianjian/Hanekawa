import { useCallback, useEffect, useRef, useState } from 'react'
import { randomUUID } from 'node:crypto'
import type {
  AskUserQuestionRequest,
  AskUserQuestionResult,
} from '../../harness/types.js'

/**
 * Bridge between the imperative AskUserQuestion tool and the React-rendered
 * AskUserQuestionDialog component. Mirrors createExitPlanProxy /
 * createPromptProxy.
 *
 * Usage:
 * 1. Call createAskUserQuestionProxy() once outside React to get a stable
 *    async function for ToolContext.askUserQuestionBridge.ask.
 * 2. Inside the React tree, call useAskUserQuestionPermission(proxy) to
 *    install the actual handler that opens the dialog and resolves on the
 *    user's choice.
 *
 * Before mount the proxy auto-rejects so the tool surfaces a clean error
 * instead of hanging.
 */
export interface AskUserQuestionProxy {
  ask(request: AskUserQuestionRequest): Promise<AskUserQuestionResult>
  setOpen(fn: (request: AskUserQuestionRequest) => Promise<AskUserQuestionResult>): void
}

export function createAskUserQuestionProxy(): AskUserQuestionProxy {
  let currentOpen: (request: AskUserQuestionRequest) => Promise<AskUserQuestionResult> = async () => ({
    kind: 'rejected',
    feedback: 'AskUserQuestion UI is not mounted.',
  })
  return {
    ask: (request) => currentOpen(request),
    setOpen: (fn) => { currentOpen = fn },
  }
}

export interface AskUserQuestionDialogState {
  visible: boolean
  request?: {
    id: string
    input: AskUserQuestionRequest
  }
}

export function useAskUserQuestionPermission(proxy: AskUserQuestionProxy) {
  const resolverRef = useRef<Map<string, (result: AskUserQuestionResult) => void>>(new Map())
  const [state, setState] = useState<AskUserQuestionDialogState>({ visible: false })

  const askFn = useCallback(
    (input: AskUserQuestionRequest): Promise<AskUserQuestionResult> => {
      return new Promise<AskUserQuestionResult>((resolve) => {
        const id = randomUUID()
        resolverRef.current.set(id, resolve)
        setState({ visible: true, request: { id, input } })
      })
    },
    [],
  )

  useEffect(() => {
    proxy.setOpen(askFn)
    return () => {
      proxy.setOpen(async () => ({
        kind: 'rejected',
        feedback: 'AskUserQuestion UI was unmounted.',
      }))
    }
  }, [proxy, askFn])

  const respond = useCallback((id: string, result: AskUserQuestionResult) => {
    const resolver = resolverRef.current.get(id)
    if (resolver) {
      resolverRef.current.delete(id)
      resolver(result)
    }
    setState((current) => {
      if (current.request?.id === id) return { visible: false }
      return current
    })
  }, [])

  return { state, respond }
}
