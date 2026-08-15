import type { PermissionRequestDto } from '../runtime/protocol/wire.js'
import type { SessionUsage } from '../runtime/sessionUsage.js'
import type {
  CompactAttemptFailedRecord,
  SessionRecord,
  ThinkingBlock,
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
      expanded?: boolean
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
      /** Prevents grouping across non-rendered boundaries such as hidden tools. */
      groupSegmentId?: number
      createdAt: string
    }
  | {
      kind: 'tool_group'
      id: string
      toolCalls: Array<Extract<TUIDisplayItem, { kind: 'tool_call' }>>
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
  /** The wire projection, so this dialog renders the same in any shell. */
  request: PermissionRequestDto
}

/** Re-homed into the headless runtime; kept as an alias for the component tree. */
export type TUIUsage = SessionUsage