import { useState, useCallback, useEffect, useRef } from 'react'
import { randomUUID } from 'node:crypto'
import type { PermissionRequest, PermissionPrompt } from '../../harness/permissions.js'
import type { SessionRecord, ToolProgressEvent } from '../../harness/types.js'
import type { PermissionDialogState } from '../types.js'

export interface RecordProxy {
  onRecord: (record: SessionRecord) => void
  setHandler: (fn: (record: SessionRecord) => void) => void
  onProgress: (event: ToolProgressEvent) => void
  setProgressHandler: (fn: (event: ToolProgressEvent) => void) => void
}

export function createRecordProxy(): RecordProxy {
  let handler: (record: SessionRecord) => void = () => {}
  let progressHandler: (event: ToolProgressEvent) => void = () => {}
  return {
    onRecord: (record) => handler(record),
    setHandler: (fn) => { handler = fn },
    onProgress: (event) => progressHandler(event),
    setProgressHandler: (fn) => { progressHandler = fn },
  }
}

/**
 * Creates a permission system that bridges the imperative PermissionGate
 * with a declarative React dialog.
 *
 * Usage:
 * 1. Call `createPromptProxy()` to get a stable PermissionPrompt function
 * 2. Pass it to PermissionGate constructor
 * 3. In the React tree, call `usePermission(promptProxy)` to wire up the dialog
 * 4. The hook replaces the proxy's internal prompt with the React-aware one
 */
export interface PermissionPromptProxy {
  prompt: PermissionPrompt
  setPrompt: (fn: PermissionPrompt) => void
}

export function createPromptProxy(): PermissionPromptProxy {
  // The proxy holds a mutable reference to the actual prompt function.
  // Initially it auto-denies (before React mounts).
  let currentPrompt: PermissionPrompt = async () => false

  return {
    prompt: (request: PermissionRequest) => currentPrompt(request),
    setPrompt: (fn: PermissionPrompt) => {
      currentPrompt = fn
    },
  }
}

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
