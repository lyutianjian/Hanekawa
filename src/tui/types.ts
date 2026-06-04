import type { PermissionRequest } from '../harness/permissions.js'
import type {
  CompactAttemptFailedRecord,
  SessionRecord,
  ThinkingBlock,
  TokenUsage,
  ToolErrorCode,
  ToolResultDisplay,
} from '../harness/types.js'

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
      thinkingBlocks?: ThinkingBlock[]
      thinkingDurationMs?: number
      thinkingPreview?: string
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
      resultDisplay?: ToolResultDisplay
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
      kind: 'subagent_task'
      id: string
      record: Extract<SessionRecord, { type: 'subagent_task' }>
      progress?: string
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

export type TUIStaticItem =
  | {
      kind: 'welcome_banner'
      id: string
      sessionShortId: string
      model: string
      providerName: string
      cwd: string
    }
  | TUIDisplayItem

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
  lastTurn: TokenUsage | null
  total: TokenUsage
}
