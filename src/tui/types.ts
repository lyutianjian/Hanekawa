import type { PermissionRequest } from '../harness/permissions.js'
import type { CompactAttemptFailedRecord, TokenUsage, ToolErrorCode } from '../harness/types.js'

export type ToolCallStatus =
  | 'pending'
  | 'running'
  | 'approved'
  | 'denied'
  | 'done'
  | 'error'

export type TUIDisplayItem =
  | {
      kind: 'user'
      id: string
      content: string
      createdAt: string
    }
  | {
      kind: 'assistant'
      id: string
      content: string
      createdAt: string
    }
  | {
      kind: 'tool_call'
      id: string
      toolUseId: string
      tool: string
      input: unknown
      status: ToolCallStatus
      result?: string
      errorCode?: ToolErrorCode
      createdAt: string
    }
  | {
      kind: 'compact_boundary'
      id: string
      summary: string
    }
  | {
      kind: 'compact_attempt_failed'
      id: string
      record: CompactAttemptFailedRecord
    }
  | {
      kind: 'tool_progress'
      id: string
      content: string
      createdAt: string
    }
  | {
      kind: 'system'
      id: string
      content: string
      createdAt: string
    }
  | {
      kind: 'error'
      id: string
      content: string
      createdAt: string
    }

export interface PermissionDialogState {
  visible: boolean
  requests: PermissionDialogRequest[]
  activeRequestId: string | null
}

export interface PermissionDialogRequest {
  id: string
  request: PermissionRequest
}

export interface TUIUsage {
  current: TokenUsage | null
  total: TokenUsage
}
