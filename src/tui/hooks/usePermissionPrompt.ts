import { useState, useCallback, useRef } from 'react'
import type { PermissionRequest } from '../../harness/permissions.js'

interface PendingPermission {
  toolName: string
  riskLevel: string
  input: unknown
  onAlwaysAllow?: () => void
}

export function usePermissionPrompt() {
  const [pendingRequest, setPendingRequest] = useState<PendingPermission | null>(null)
  const resolveRef = useRef<((approved: boolean) => void) | null>(null)

  const requestPermission = useCallback(async (request: PermissionRequest): Promise<boolean> => {
    return new Promise<boolean>((resolve) => {
      resolveRef.current = resolve
      setPendingRequest({
        toolName: request.tool.name,
        riskLevel: request.tool.riskLevel,
        input: request.input,
        onAlwaysAllow: request.onAlwaysAllow,
      })
    })
  }, [])

  const approve = useCallback(() => {
    resolveRef.current?.(true)
    resolveRef.current = null
    setPendingRequest(null)
  }, [])

  const deny = useCallback(() => {
    resolveRef.current?.(false)
    resolveRef.current = null
    setPendingRequest(null)
  }, [])

  const approveAll = useCallback(() => {
    pendingRequest?.onAlwaysAllow?.()
    resolveRef.current?.(true)
    resolveRef.current = null
    setPendingRequest(null)
  }, [pendingRequest])

  return {
    pendingRequest,
    requestPermission,
    approve,
    deny,
    approveAll,
  }
}
