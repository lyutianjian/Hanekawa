import { useState, useCallback, useEffect, useRef } from 'react'
import { randomUUID } from 'node:crypto'
import type { PermissionRequest } from '../../harness/permissions.js'
import type { PermissionDialogState } from '../types.js'
import { toPermissionDto } from '../../runtime/protocol/permissionDto.js'
import type { PermissionPromptProxy } from '../../runtime/bridges.js'

export { createPromptProxy, createRecordProxy } from '../../runtime/bridges.js'
export type { PermissionPromptProxy, RecordProxy } from '../../runtime/bridges.js'

/**
 * Wires a {@link PermissionPromptProxy} up to a declarative React dialog.
 *
 * Usage:
 * 1. Call `createPromptProxy()` (outside React) and pass it to PermissionGate
 * 2. In the React tree, call `usePermission(promptProxy, { cwd })` to wire up the dialog
 * 3. The hook replaces the proxy's internal prompt with the React-aware one
 *
 * The dialog renders a {@link PermissionRequestDto}, not the live request, so
 * the same component works over the wire. The live request stays here because
 * `onAlwaysAllow` is a callback and cannot cross a process boundary — this
 * mirrors `SessionHost`, which keeps its own map for exactly that reason.
 */
export function usePermission(proxy: PermissionPromptProxy, options: { cwd: string }) {
  const { cwd } = options
  const resolverRef = useRef(new Map<string, (approved: boolean) => void>())
  /** Live requests keyed by dialog id, so `onAlwaysAllow` survives the round trip. */
  const liveRef = useRef(new Map<string, PermissionRequest>())
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
        liveRef.current.set(id, request)
        // Built once, here. The dialog used to rebuild the file preview on
        // every render, re-reading the file from disk each time.
        const dto = toPermissionDto(request, { cwd })
        setPermState((current) => ({
          visible: true,
          requests: [...current.requests, { id, request: dto }],
          activeRequestId: current.activeRequestId ?? id,
        }))
      })
    },
    [cwd],
  )

  // Inject the prompt function into the proxy on mount
  useEffect(() => {
    proxy.setPrompt(promptFn)
    return () => {
      // Deny whatever the dialog was still holding before letting go of the
      // proxy: PermissionGate awaits these promises and ToolRunner does not
      // pass its abort signal down, so an abandoned resolver hangs the tool
      // call forever. Detaching (rather than installing an auto-deny) means a
      // later request parks for the next UI instead of being denied silently.
      const resolvers = [...resolverRef.current.values()]
      resolverRef.current.clear()
      liveRef.current.clear()
      proxy.clearPrompt()
      for (const resolver of resolvers) resolver(false)
    }
  }, [proxy, promptFn])

  // Called when the user responds to the dialog
  const respond = useCallback((id: string, approved: boolean, alwaysAllow?: boolean) => {
    const resolver = resolverRef.current.get(id)
    const live = liveRef.current.get(id)
    resolverRef.current.delete(id)
    liveRef.current.delete(id)
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
    // Must run before the resolver: PermissionGate captures the "always allow"
    // flag into a local and reads it on the line after the prompt resolves.
    if (approved && alwaysAllow) live?.onAlwaysAllow?.()
    resolver?.(approved)
  }, [])

  const denyPending = useCallback(() => {
    const resolvers = [...resolverRef.current.values()]
    resolverRef.current.clear()
    liveRef.current.clear()
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
