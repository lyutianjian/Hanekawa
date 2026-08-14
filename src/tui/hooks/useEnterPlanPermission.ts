import { useCallback, useEffect, useRef, useState } from 'react'
import { randomUUID } from 'node:crypto'
import type { EnterPlanPromptProxy } from '../../runtime/bridges.js'

export { createEnterPlanProxy } from '../../runtime/bridges.js'
export type { EnterPlanPromptProxy } from '../../runtime/bridges.js'

/**
 * Renders the {@link EnterPlanPromptProxy} bridge as the React
 * EnterPlanModeDialog.
 *
 * Usage:
 * 1. Call createEnterPlanProxy() once (outside React) to get a stable
 *    async function suitable for PlanModeManagerDeps.openEnterPrompt.
 * 2. Inside the React tree, call useEnterPlanPermission(proxy) to install
 *    the actual handler that opens the dialog and resolves on user choice.
 */
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
