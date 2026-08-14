import { useState, useCallback, useEffect, useRef } from 'react'
import { randomUUID } from 'node:crypto'
import type { PermissionRequest } from '../../harness/permissions.js'
import type { PermissionDialogState } from '../types.js'
import type { PermissionPromptProxy } from '../../runtime/bridges.js'

export { createPromptProxy, createRecordProxy } from '../../runtime/bridges.js'
export type { PermissionPromptProxy, RecordProxy } from '../../runtime/bridges.js'

/**
 * Wires a {@link PermissionPromptProxy} up to a declarative React dialog.
 *
 * Usage:
 * 1. Call `createPromptProxy()` (outside React) and pass it to PermissionGate
 * 2. In the React tree, call `usePermission(promptProxy)` to wire up the dialog
 * 3. The hook replaces the proxy's internal prompt with the React-aware one
 */
export function usePermission(proxy: PermissionPromptProxy) {
  const resolverRef = useRef(new Map<string, (approved: boolean) => void>())
  const [permState, setPermState] = useState<PermissionDialogState>({
    visible: false,
    requests: [],
    activeRequestId: null,
  })

  // The actual prompt function that shows the dialog and waits for user response
  const promptFn = useCallback(
    (request: PermissionRequest): Promise<boolean> => {
      return new Promise<boolean>((resolve) => {
        const id = randomUUID()
        resolverRef.current.set(id, resolve)
        setPermState((current) => ({
          visible: true,
          requests: [...current.requests, { id, request }],
          activeRequestId: current.activeRequestId ?? id,
        }))
      })
    },
    [],
  )

  // Inject the prompt function into the proxy on mount
  useEffect(() => {
    proxy.setPrompt(promptFn)
    return () => {
      // Reset to auto-deny on unmount
      proxy.setPrompt(async () => false)
    }
  }, [proxy, promptFn])

  // Called when the user responds to the dialog
  const respond = useCallback((id: string, approved: boolean) => {
    const resolver = resolverRef.current.get(id)
    resolverRef.current.delete(id)
    setPermState((current) => {
      const requests = current.requests.filter((entry) => entry.id !== id)
      const activeRequestId = current.activeRequestId === id
        ? requests[0]?.id ?? null
        : current.activeRequestId
      return {
        visible: requests.length > 0,
        requests,
        activeRequestId,
      }
    })
    resolver?.(approved)
  }, [])

  const denyPending = useCallback(() => {
    const resolvers = [...resolverRef.current.values()]
    resolverRef.current.clear()
    setPermState({
      visible: false,
      requests: [],
      activeRequestId: null,
    })
    for (const resolver of resolvers) {
      resolver(false)
    }
  }, [])

  const setActiveRequest = useCallback((id: string) => {
    setPermState((current) => (
      current.requests.some((entry) => entry.id === id)
        ? { ...current, activeRequestId: id }
        : current
    ))
  }, [])

  return { permState, respond, setActiveRequest, denyPending }
}
