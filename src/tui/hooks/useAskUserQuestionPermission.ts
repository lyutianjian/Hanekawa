import { useCallback, useEffect, useRef, useState } from 'react'
import { randomUUID } from 'node:crypto'
import type {
  AskUserQuestionRequest,
  AskUserQuestionResult,
} from '../../harness/types.js'
import type { AskUserQuestionProxy } from '../../runtime/bridges.js'

export { createAskUserQuestionProxy } from '../../runtime/bridges.js'
export type { AskUserQuestionProxy } from '../../runtime/bridges.js'

/**
 * Renders the {@link AskUserQuestionProxy} bridge as the React
 * AskUserQuestionDialog.
 *
 * Usage:
 * 1. Call createAskUserQuestionProxy() once outside React to get a stable
 *    async function for ToolContext.askUserQuestionBridge.ask.
 * 2. Inside the React tree, call useAskUserQuestionPermission(proxy) to
 *    install the actual handler that opens the dialog and resolves on the
 *    user's choice.
 */
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
      // Settle whatever the dialog was still holding first: an abandoned
      // resolver leaves the AskUserQuestion tool awaiting forever.
      const unmounted = (): AskUserQuestionResult => ({
        kind: 'rejected',
        feedback: 'AskUserQuestion UI was unmounted.',
      })
      const resolvers = [...resolverRef.current.values()]
      resolverRef.current.clear()
      proxy.setOpen(async () => unmounted())
      for (const resolver of resolvers) resolver(unmounted())
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
