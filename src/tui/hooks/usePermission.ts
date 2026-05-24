import { useState, useCallback, useEffect } from 'react'
import type { PermissionRequest, PermissionPrompt } from '../../harness/permissions.js'
import type { SessionRecord } from '../../harness/types.js'
import type { PermissionDialogState } from '../types.js'

export interface RecordProxy {
  onRecord: (record: SessionRecord) => void
  setHandler: (fn: (record: SessionRecord) => void) => void
}

export function createRecordProxy(): RecordProxy {
  let handler: (record: SessionRecord) => void = () => {}
  return {
    onRecord: (record) => handler(record),
    setHandler: (fn) => { handler = fn },
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
  const [permState, setPermState] = useState<PermissionDialogState>({
    visible: false,
    request: null,
    resolve: null,
  })

  // The actual prompt function that shows the dialog and waits for user response
  const promptFn = useCallback(
    (request: PermissionRequest): Promise<boolean> => {
      return new Promise<boolean>((resolve) => {
        setPermState({ visible: true, request, resolve })
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
  const respond = useCallback(
    (approved: boolean) => {
      permState.resolve?.(approved)
      setPermState({ visible: false, request: null, resolve: null })
    },
    [permState.resolve],
  )

  return { permState, respond }
}
