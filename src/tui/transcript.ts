import type { SessionRecord, ToolProgressEvent } from '../harness/types.js'
import type { TUIDisplayItem } from './types.js'
import { ENTER_PLAN_MODE_TOOL_NAME, EXIT_PLAN_MODE_TOOL_NAME } from '../tools/toolNames.js'

export interface TuiTranscriptState {
  staticItems: TUIDisplayItem[]
  liveItems: TUIDisplayItem[]
  recentCompletedToolCall: Extract<TUIDisplayItem, { kind: 'tool_call' }> | null
  recentThinkingAssistant: Extract<TUIDisplayItem, { kind: 'assistant' }> | null
}

export interface ApplyRecordOptions {
  approvalToolUseId?: string
  subagentProgress?: string
}

export function createTranscriptState(staticItems: TUIDisplayItem[] = []): TuiTranscriptState {
  const recentCompletedToolCall = findRecentCompletedToolCall(staticItems)
  const recentThinkingAssistant = findRecentThinkingAssistant(staticItems)
  return {
    staticItems,
    liveItems: [],
    recentCompletedToolCall,
    recentThinkingAssistant,
  }
}

export function appendStaticTranscriptItem(
  state: TuiTranscriptState,
  item: TUIDisplayItem,
): TuiTranscriptState {
  return {
    ...state,
    staticItems: [...state.staticItems, item],
    recentCompletedToolCall: item.kind === 'tool_call' && item.result
      ? item
      : state.recentCompletedToolCall,
    recentThinkingAssistant: item.kind === 'assistant' && item.thinkingBlocks && item.thinkingBlocks.length > 0
      ? item
      : state.recentThinkingAssistant,
  }
}

export function applyTuiRecordToTranscriptState(
  state: TuiTranscriptState,
  record: SessionRecord,
  options: ApplyRecordOptions = {},
): TuiTranscriptState {
  if (record.type === 'message') {
    return appendStaticTranscriptItem(state, messageRecordToDisplayItem(record))
  }

  if (record.type === 'tool_use') {
    if (isHiddenToolCall(record.tool)) return state
    const item: Extract<TUIDisplayItem, { kind: 'tool_call' }> = {
      kind: 'tool_call',
      id: `tool-call-${record.id}`,
      toolUseId: record.id,
      tool: record.tool,
      input: record.input,
      status: 'running',
      createdAt: record.createdAt,
    }
    return upsertLiveItem(state, item, (candidate) =>
      candidate.kind === 'tool_call' && candidate.toolUseId === record.id
    )
  }

  if (record.type === 'tool_approval') {
    if (isHiddenToolCall(record.tool) || !options.approvalToolUseId) return state
    return updateLiveItem(state, (item) => {
      if (item.kind !== 'tool_call' || item.toolUseId !== options.approvalToolUseId) return item
      return {
        ...item,
        status: record.approved ? 'approved' : 'denied',
      }
    })
  }

  if (record.type === 'tool_result') {
    if (isHiddenToolCall(record.tool)) return state
    const liveItem = state.liveItems.find(
      (item): item is Extract<TUIDisplayItem, { kind: 'tool_call' }> =>
        item.kind === 'tool_call' && item.toolUseId === record.toolUseId,
    )
    if (!liveItem) return state
    const completed: Extract<TUIDisplayItem, { kind: 'tool_call' }> = {
      ...liveItem,
      status: record.ok ? 'done' : 'error',
      result: record.content,
      resultDisplay: record.display,
      errorCode: record.errorCode,
    }
    return appendStaticTranscriptItem({
      ...state,
      liveItems: state.liveItems.filter((item) =>
        !(item.kind === 'tool_call' && item.toolUseId === record.toolUseId)
      ),
    }, completed)
  }

  if (record.type === 'compact_boundary') {
    return appendStaticTranscriptItem(state, {
      kind: 'compact_boundary',
      id: record.id,
      summary: record.summary,
    })
  }

  if (record.type === 'compact_attempt_failed') {
    return appendStaticTranscriptItem(state, {
      kind: 'compact_attempt_failed',
      id: record.id,
      record,
    })
  }

  if (record.type === 'subagent_task') {
    const item: Extract<TUIDisplayItem, { kind: 'subagent_task' }> = {
      kind: 'subagent_task',
      id: `subagent-task-${record.agentId}`,
      record,
      progress: options.subagentProgress,
      createdAt: record.createdAt,
    }
    const withoutCurrent = {
      ...state,
      liveItems: state.liveItems.filter((candidate) =>
        !(candidate.kind === 'subagent_task' && candidate.record.agentId === record.agentId)
      ),
    }
    if (record.status === 'running') {
      return {
        ...withoutCurrent,
        liveItems: [...withoutCurrent.liveItems, item],
      }
    }
    return appendStaticTranscriptItem(withoutCurrent, item)
  }

  return state
}

export function applyToolProgressToTranscriptState(
  state: TuiTranscriptState,
  input: {
    listContent?: string
    subagentProgressByAgentId?: ReadonlyMap<string, string>
    createdAt?: string
  },
): TuiTranscriptState {
  const progressByAgentId = input.subagentProgressByAgentId ?? new Map<string, string>()
  const withoutProgress = state.liveItems.filter((item) => item.kind !== 'tool_progress')
  const withSubagentProgress = withoutProgress.map((item) => {
    if (item.kind !== 'subagent_task') return item
    return {
      ...item,
      progress: progressByAgentId.get(item.record.agentId),
    }
  })
  const liveItems = input.listContent
    ? [
        ...withSubagentProgress,
        {
          kind: 'tool_progress' as const,
          id: 'tool-progress',
          content: input.listContent,
          createdAt: input.createdAt ?? new Date().toISOString(),
        },
      ]
    : withSubagentProgress

  return {
    ...state,
    liveItems,
  }
}

export function clearToolProgress(state: TuiTranscriptState): TuiTranscriptState {
  return {
    ...state,
    liveItems: state.liveItems.filter((item) => item.kind !== 'tool_progress'),
  }
}

export function recordsToDisplayItems(records: SessionRecord[]): TUIDisplayItem[] {
  const items: TUIDisplayItem[] = []
  const toolCalls = new Map<string, Extract<TUIDisplayItem, { kind: 'tool_call' }>>()
  const latestSubagentRecordId = new Map<string, string>()

  for (const record of records) {
    if (record.type === 'subagent_task') {
      latestSubagentRecordId.set(record.agentId, record.id)
    }
  }

  for (const record of records) {
    if (record.type === 'message') {
      items.push(messageRecordToDisplayItem(record))
    } else if (record.type === 'tool_use') {
      if (isHiddenToolCall(record.tool)) continue
      const item: Extract<TUIDisplayItem, { kind: 'tool_call' }> = {
        kind: 'tool_call',
        id: `tool-call-${record.id}`,
        toolUseId: record.id,
        tool: record.tool,
        input: record.input,
        status: 'done',
        createdAt: record.createdAt,
      }
      toolCalls.set(record.id, item)
      items.push(item)
    } else if (record.type === 'tool_result') {
      if (isHiddenToolCall(record.tool)) continue
      const matchingCall = toolCalls.get(record.toolUseId)
      if (matchingCall) {
        matchingCall.result = record.content
        matchingCall.resultDisplay = record.display
        matchingCall.status = record.ok ? 'done' : 'error'
        matchingCall.errorCode = record.errorCode
      }
    } else if (record.type === 'compact_boundary') {
      items.push({
        kind: 'compact_boundary',
        id: record.id,
        summary: record.summary,
      })
    } else if (record.type === 'compact_attempt_failed') {
      items.push({
        kind: 'compact_attempt_failed',
        id: record.id,
        record,
      })
    } else if (record.type === 'subagent_task') {
      if (latestSubagentRecordId.get(record.agentId) !== record.id) continue
      const displayRecord = record.status === 'running'
        ? { ...record, status: 'interrupted' as const }
        : record
      items.push({
        kind: 'subagent_task',
        id: `subagent-task-${displayRecord.agentId}`,
        record: displayRecord,
        createdAt: displayRecord.createdAt,
      })
    }
  }

  return items
}

export function isHiddenToolCall(toolName: string): boolean {
  return toolName === ENTER_PLAN_MODE_TOOL_NAME
    || toolName === EXIT_PLAN_MODE_TOOL_NAME
    || isTaskStatusTool(toolName)
}

function messageRecordToDisplayItem(
  record: Extract<SessionRecord, { type: 'message' }>,
): TUIDisplayItem {
  return {
    kind: record.role === 'user' ? 'user' : record.role === 'assistant' ? 'assistant' : 'system',
    id: record.id,
    content: record.content,
    ...(record.role === 'assistant' && record.thinkingBlocks && record.thinkingBlocks.length > 0
      ? { thinkingBlocks: record.thinkingBlocks }
      : {}),
    createdAt: record.createdAt,
  }
}

function upsertLiveItem(
  state: TuiTranscriptState,
  item: TUIDisplayItem,
  matches: (item: TUIDisplayItem) => boolean,
): TuiTranscriptState {
  const index = state.liveItems.findIndex(matches)
  if (index < 0) {
    return {
      ...state,
      liveItems: [...state.liveItems, item],
    }
  }
  const liveItems = [...state.liveItems]
  liveItems[index] = item
  return {
    ...state,
    liveItems,
  }
}

function updateLiveItem(
  state: TuiTranscriptState,
  update: (item: TUIDisplayItem) => TUIDisplayItem,
): TuiTranscriptState {
  return {
    ...state,
    liveItems: state.liveItems.map(update),
  }
}

function findRecentCompletedToolCall(
  items: readonly TUIDisplayItem[],
): Extract<TUIDisplayItem, { kind: 'tool_call' }> | null {
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index]
    if (item?.kind === 'tool_call' && item.result) return item
  }
  return null
}

function findRecentThinkingAssistant(
  items: readonly TUIDisplayItem[],
): Extract<TUIDisplayItem, { kind: 'assistant' }> | null {
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index]
    if (item?.kind === 'assistant' && item.thinkingBlocks && item.thinkingBlocks.length > 0) return item
  }
  return null
}

function isTaskStatusTool(toolName: string): boolean {
  return toolName === 'TodoWrite'
    || toolName === 'TaskCreate'
    || toolName === 'TaskList'
    || toolName === 'TaskGet'
    || toolName === 'TaskUpdate'
}
