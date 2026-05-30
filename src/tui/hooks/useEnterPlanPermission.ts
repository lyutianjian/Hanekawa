import { useCallback, useEffect, useRef, useState } from 'react'
import { randomUUID } from 'node:crypto'

/**
 * Bridge between the imperative PlanModeManager.openEnterPrompt dependency
 * and the React-rendered EnterPlanModeDialog component. Mirrors the
 * createExitPlanProxy / createAskUserQuestionProxy pattern.
 *
 * Usage:
 * 1. Call createEnterPlanProxy() once (outside React) to get a stable
 *    async function suitable for PlanModeManagerDeps.openEnterPrompt.
 * 2. Inside the React tree, call useEnterPlanPermission(proxy) to install
 *    the actual handler that opens the dialog and resolves on user choice.
 *
 * Before mount the proxy auto-approves entry, mirroring the existing
 * fallback in PlanModeManager.processEnterRequest where a missing
 * openEnterPrompt was implicitly treated as "approve". This keeps backwards
 * compatibility with headless / unit-test paths that never mount the UI.
 */
export interface EnterPlanPromptProxy {
  open(): Promise<boolean>
  setOpen(fn: () => Promise<boolean>): void
}

export function createEnterPlanProxy(): EnterPlanPromptProxy {
  let currentOpen: () => Promise<boolean> = async () => true
  return {
    open: () => currentOpen(),
    setOpen: (fn) => { currentOpen = fn },
  }
}

export interface EnterPlanDialogState {
  visible: boolean
  request?: {
    id: string
  }
}

export function useEnterPlanPermission(proxy: EnterPlanPromptProxy) {
  const resolverRef = useRef<Map<string, (approved: boolean) => void>>(new Map())
  const [state, setState] = useState<EnterPlanDialogState>({ visible: false })

  const openFn = useCallback((): Promise<boolean> => {
    return new Promise<boolean>((resolve) => {
      const id = randomUUID()
      resolverRef.current.set(id, resolve)
      setState({ visible: true, request: { id } })
    })
  }, [])

  useEffect(() => {
    proxy.setOpen(openFn)
    return () => {
      // After unmount, fall back to auto-approve so headless paths still work.
      proxy.setOpen(async () => true)
    }
  }, [proxy, openFn])

  const respond = useCallback((id: string, approved: boolean) => {
    const resolver = resolverRef.current.get(id)
    if (resolver) {
      resolverRef.current.delete(id)
      resolver(approved)
    }
    setState((current) => {
      if (current.request?.id === id) return { visible: false }
      return current
    })
  }, [])

  return { state, respond }
}
