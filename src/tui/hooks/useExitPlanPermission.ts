import { useCallback, useEffect, useRef, useState } from 'react'
import { randomUUID } from 'node:crypto'
import type {
  ExitDialogInput,
  ExitPlanDecision,
} from '../../harness/planModeManager.js'
import type { ExitPlanPromptProxy } from '../../runtime/bridges.js'

export { createExitPlanProxy } from '../../runtime/bridges.js'
export type { ExitPlanPromptProxy } from '../../runtime/bridges.js'

/**
 * Renders the {@link ExitPlanPromptProxy} bridge as the React
 * ExitPlanModeDialog. Mirrors the createPromptProxy / usePermission pattern.
 *
 * Usage:
 * 1. Call createExitPlanProxy() once (outside React) to get a stable async
 *    function for PlanModeManagerDeps.openExitDialog.
 * 2. Inside the React tree, call useExitPlanPermission(proxy) to install
 *    the actual handler that opens the dialog and resolves on user choice.
 */
export interface ExitPlanDialogState {
  visible: boolean
  request?: {
    id: string
    input: ExitDialogInput
  }
}

export function useExitPlanPermission(proxy: ExitPlanPromptProxy) {
  const resolverRef = useRef<Map<string, (decision: ExitPlanDecision) => void>>(new Map())
  const [state, setState] = useState<ExitPlanDialogState>({ visible: false })

  const openFn = useCallback(
    (input: ExitDialogInput): Promise<ExitPlanDecision> => {
      return new Promise<ExitPlanDecision>((resolve) => {
        const id = randomUUID()
        resolverRef.current.set(id, resolve)
        setState({ visible: true, request: { id, input } })
      })
    },
    [],
  )

  useEffect(() => {
    proxy.setOpen(openFn)
    return () => {
      // Settle whatever the dialog was still holding first: an abandoned
      // resolver leaves PlanModeManager awaiting forever.
      const resolvers = [...resolverRef.current.values()]
      resolverRef.current.clear()
      proxy.setOpen(async () => ({ kind: 'reject', feedback: '' }))
      for (const resolver of resolvers) resolver({ kind: 'reject', feedback: '' })
    }
  }, [proxy, openFn])

  const respond = useCallback((id: string, decision: ExitPlanDecision) => {
    const resolver = resolverRef.current.get(id)
    if (resolver) {
      resolverRef.current.delete(id)
      resolver(decision)
    }
    setState((current) => {
      if (current.request?.id === id) return { visible: false }
      return current
    })
  }, [])

  return { state, respond }
}
