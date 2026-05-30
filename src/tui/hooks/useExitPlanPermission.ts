import { useCallback, useEffect, useRef, useState } from 'react'
import { randomUUID } from 'node:crypto'
import type {
  ExitDialogInput,
  ExitPlanDecision,
} from '../../harness/planModeManager.js'

/**
 * Bridge between the imperative PlanModeManager.openExitDialog dependency
 * and the React-rendered ExitPlanModeDialog component. Mirrors the
 * createPromptProxy / usePermission pattern in {@link usePermission}.
 *
 * Usage:
 * 1. Call createExitPlanProxy() once (outside React) to get a stable async
 *    function for PlanModeManagerDeps.openExitDialog.
 * 2. Inside the React tree, call useExitPlanPermission(proxy) to install
 *    the actual handler that opens the dialog and resolves on user choice.
 *
 * Before mount the proxy auto-rejects with empty feedback so the manager
 * can still drive a clean test run.
 */
export interface ExitPlanPromptProxy {
  open(input: ExitDialogInput): Promise<ExitPlanDecision>
  setOpen(fn: (input: ExitDialogInput) => Promise<ExitPlanDecision>): void
}

export function createExitPlanProxy(): ExitPlanPromptProxy {
  let currentOpen: (input: ExitDialogInput) => Promise<ExitPlanDecision> = async () => ({
    kind: 'reject',
    feedback: '',
  })
  return {
    open: (input) => currentOpen(input),
    setOpen: (fn) => { currentOpen = fn },
  }
}

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
      proxy.setOpen(async () => ({ kind: 'reject', feedback: '' }))
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
