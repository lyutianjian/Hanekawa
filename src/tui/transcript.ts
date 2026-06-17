import type { SessionRecord, ToolProgressEvent } from '../harness/types.js'
import type { TUIDisplayItem } from './types.js'
import { ASK_USER_QUESTION_TOOL_NAME, ENTER_PLAN_MODE_TOOL_NAME, EXIT_PLAN_MODE_TOOL_NAME, TASK_CREATE_TOOL_NAME, TASK_GET_TOOL_NAME, TASK_LIST_TOOL_NAME, TASK_UPDATE_TOOL_NAME } from '../tools/toolNames.js'
import { TOOL_SEARCH_TOOL_NAME } from '../tools/ToolSearchTool/constants.js'
import { groupConsecutiveSafeToolCalls } from './utils/toolGroupSummary.js'

export interface TuiTranscriptState {
  staticItems: TUIDisplayItem[]
  liveItems: TUIDisplayItem[]
  liveSystemItems: TUIDisplayItem[]
  recentCompletedToolCall: Extract<TUIDisplayItem, { kind: 'tool_call' }> | null
  recentThinkingAssistant: Extract<TUIDisplayItem, { kind: 'assistant' }> | null
}

export interface ApplyRecordOptions {
  approvalToolUseId?: string
  subagentProgress?: string
  thinkingDurationMs?: number
}

export function createTranscriptState(staticItems: TUIDisplayItem[] = []): TuiTranscriptState {
  const recentCompletedToolCall = findRecentCompletedToolCall(staticItems)
  const recentThinkingAssistant = findRecentThinkingAssistant(staticItems)
  return {
    staticItems,
    liveItems: [],
    liveSystemItems: [],
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

/** Append a system item to the live system area (rendered after MessageList,
 *  below thinking blocks). Commits to static at the start of the next turn. */
export function appendLiveSystemItem(
  state: TuiTranscriptState,
  item: TUIDisplayItem,
): TuiTranscriptState {
  return {
    ...state,
    liveSystemItems: [...state.liveSystemItems, item],
  }
}

/** Move all live items to static (called at the start of a new turn).
 *  Streaming thinking preview items are discarded — they are temporary
 *  placeholders replaced by the real assistant message. */
export function commitLiveItemsToStatic(state: TuiTranscriptState): TuiTranscriptState {
  if (state.liveItems.length === 0 && state.liveSystemItems.length === 0) return state
  const toCommit = state.liveItems.filter((item) => !isStreamingThinkingPreview(item))
  if (toCommit.length === 0 && state.liveSystemItems.length === 0) {
    return { ...state, liveItems: [], liveSystemItems: [] }
  }
  const grouped = groupConsecutiveSafeToolCalls(toCommit)
  return {
    ...state,
    staticItems: [...state.staticItems, ...grouped, ...state.liveSystemItems],
    liveItems: [],
    liveSystemItems: [],
  }
}

/** Move ALL live items to static at turn end — including thinking-bearing
 *  assistant messages. Streaming thinking preview items are discarded.
 *  Ctrl+O expansion is handled by MessageList's fallback: when the thinking
 *  item is no longer in liveItems, MessageList renders an expanded copy at
 *  the bottom of the live area using recentThinkingAssistant from state. */
export function commitAllLiveItemsToStatic(state: TuiTranscriptState): TuiTranscriptState {
  if (state.liveItems.length === 0 && state.liveSystemItems.length === 0) return state
  const toCommit = state.liveItems.filter((item) => !isStreamingThinkingPreview(item))
  if (toCommit.length === 0 && state.liveSystemItems.length === 0) {
    return { ...state, liveItems: [], liveSystemItems: [] }
  }
  const recentThinkingAssistant = findRecentThinkingAssistant(toCommit) ?? state.recentThinkingAssistant
  const recentCompletedToolCall = findRecentCompletedToolCall(toCommit) ?? state.recentCompletedToolCall
  const grouped = groupConsecutiveSafeToolCalls(toCommit)
  return {
    ...state,
    staticItems: [...state.staticItems, ...grouped, ...state.liveSystemItems],
    liveItems: [],
    liveSystemItems: [],
    recentThinkingAssistant,
    recentCompletedToolCall,
  }
}

/** Move non-thinking items to static, keeping thinking blocks in liveItems
 *  so MessageList can expand them in-place via Ctrl+O (called at turn end).
 *  Streaming thinking preview items are discarded. */
export function commitLiveItemsExcludingThinking(state: TuiTranscriptState): TuiTranscriptState {
  if (state.liveItems.length === 0 && state.liveSystemItems.length === 0) return state
  const thinking = state.liveItems.filter(
    (item) => item.kind === 'assistant' && item.thinkingBlocks && item.thinkingBlocks.length > 0,
  )
  const nonThinking = state.liveItems.filter(
    (item) => !(item.kind === 'assistant' && item.thinkingBlocks && item.thinkingBlocks.length > 0)
      && !isStreamingThinkingPreview(item),
  )
  if (nonThinking.length === 0 && thinking.length === 0 && state.liveSystemItems.length === 0) {
    return { ...state, liveItems: [], liveSystemItems: [] }
  }
  if (nonThinking.length === 0 && state.liveSystemItems.length === 0) {
    return { ...state, liveItems: thinking }
  }
  const grouped = groupConsecutiveSafeToolCalls(nonThinking)
  return {
    ...state,
    staticItems: [...state.staticItems, ...grouped, ...state.liveSystemItems],
    liveItems: thinking,
    liveSystemItems: [],
  }
}

/** Create or update a streaming thinking preview item in liveItems.
 *  Used during model streaming to show the first sentence of thinking in-place. */
export function applyStreamingThinkingPreview(
  state: TuiTranscriptState,
  id: string,
  preview: string | undefined,
): TuiTranscriptState {
  const existing = state.liveItems.find((item) => item.id === id)
  if (existing && existing.kind === 'assistant') {
    return {
      ...state,
      liveItems: state.liveItems.map((item) =>
        item.id === id ? { ...item, thinkingPreview: preview } : item,
      ),
    }
  }
  const item: Extract<TUIDisplayItem, { kind: 'assistant' }> = {
    kind: 'assistant',
    id,
    content: '',
    thinkingBlocks: [],
    thinkingPreview: preview,
    createdAt: new Date().toISOString(),
  }
  return {
    ...state,
    liveItems: [...state.liveItems, item],
    recentThinkingAssistant: item,
  }
}

export function applyTuiRecordToTranscriptState(
  state: TuiTranscriptState,
  record: SessionRecord,
  options: ApplyRecordOptions = {},
): TuiTranscriptState {
  if (record.type === 'message') {
    const item = messageRecordToDisplayItem(record, options.thinkingDurationMs)
    // Assistant messages with thinking blocks go to liveItems so MessageList
    // can control expanded/collapsed state via ctrl+o.
    if (item.kind === 'assistant' && item.thinkingBlocks && item.thinkingBlocks.length > 0) {
      // Move finalized thinking items to static; discard streaming preview items
      const isFinalizedThinking = (li: TUIDisplayItem) =>
        li.kind === 'assistant' && li.thinkingBlocks && li.thinkingBlocks.length > 0
      const existingThinking = state.liveItems.filter(isFinalizedThinking)
      const remainingLive = state.liveItems.filter(
        (li) => !isFinalizedThinking(li) && !isStreamingThinkingPreview(li),
      )
      return {
        ...state,
        staticItems: [...state.staticItems, ...existingThinking],
        liveItems: [...remainingLive, item],
        recentThinkingAssistant: item,
      }
    }
    return appendStaticTranscriptItem(state, item)
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
    const toolCallIndex = state.liveItems.findIndex(
      (item) => item.kind === 'tool_call' && item.toolUseId === record.toolUseId,
    )
    if (toolCallIndex < 0) return state
    const liveItem = state.liveItems[toolCallIndex] as Extract<TUIDisplayItem, { kind: 'tool_call' }>
    const completed: Extract<TUIDisplayItem, { kind: 'tool_call' }> = {
      ...liveItem,
      status: record.ok ? 'done' : 'error',
      result: record.content,
      resultDisplay: record.display,
      errorCode: record.errorCode,
    }
    // Commit items that chronologically precede this tool_call to static,
    // preserving their order. This includes:
    // - User messages (so they appear above tool output)
    // - Thinking blocks (so they appear before the tool_call, not after)
    // Streaming thinking previews are discarded (they are temporary placeholders).
    // Other running tool_calls are kept in liveItems — they'll be committed
    // when their own result arrives.
    const indicesToCommit = new Set<number>()
    const itemsToCommit: TUIDisplayItem[] = []
    for (let i = 0; i < toolCallIndex; i++) {
      const item = state.liveItems[i]
      if (isStreamingThinkingPreview(item)) {
        indicesToCommit.add(i)
        continue
      }
      if (
        item.kind === 'user'
        || (item.kind === 'assistant' && item.thinkingBlocks && item.thinkingBlocks.length > 0)
      ) {
        indicesToCommit.add(i)
        itemsToCommit.push(item)
      }
    }
    // Also remove the completed tool_call itself from liveItems
    const remainingLive = state.liveItems.filter(
      (_, index) => !indicesToCommit.has(index) && index !== toolCallIndex,
    )
    const stateWithItemsCommitted: TuiTranscriptState = itemsToCommit.length > 0
      ? {
          ...state,
          liveItems: remainingLive,
          staticItems: [...state.staticItems, ...itemsToCommit],
        }
      : {
          ...state,
          liveItems: remainingLive,
        }
    return appendStaticTranscriptItem(stateWithItemsCommitted, completed)
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

/**
 * Commit user messages, thinking blocks, and other preceding items from
 * liveItems to staticItems. Streaming thinking previews are discarded.
 *
 * Called when a hidden tool_result arrives (e.g. TaskCreate, TaskUpdate)
 * so that user messages and thinking blocks are committed to static in
 * the correct chronological order, even though the tool itself has no
 * visible tool_call in liveItems.
 *
 * Without this, user messages would stay in liveItems until turn end
 * and end up AFTER assistant messages in the static transcript.
 */
export function commitPrecedingLiveItemsToStatic(state: TuiTranscriptState): TuiTranscriptState {
  const indicesToCommit = new Set<number>()
  const itemsToCommit: TUIDisplayItem[] = []
  for (let i = 0; i < state.liveItems.length; i++) {
    const item = state.liveItems[i]
    if (isStreamingThinkingPreview(item)) {
      indicesToCommit.add(i)
      continue
    }
    if (
      item.kind === 'user'
      || (item.kind === 'assistant' && item.thinkingBlocks && item.thinkingBlocks.length > 0)
    ) {
      indicesToCommit.add(i)
      itemsToCommit.push(item)
    }
  }
  if (itemsToCommit.length === 0) return state
  const remainingLive = state.liveItems.filter((_, index) => !indicesToCommit.has(index))
  return {
    ...state,
    liveItems: remainingLive,
    staticItems: [...state.staticItems, ...itemsToCommit],
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

  return groupConsecutiveSafeToolCalls(items)
}

export function isHiddenToolCall(toolName: string): boolean {
  return toolName === ENTER_PLAN_MODE_TOOL_NAME
    || toolName === EXIT_PLAN_MODE_TOOL_NAME
    || toolName === TOOL_SEARCH_TOOL_NAME
    || toolName === ASK_USER_QUESTION_TOOL_NAME
    || toolName === 'Skill'
    || toolName === TASK_CREATE_TOOL_NAME
    || toolName === TASK_GET_TOOL_NAME
    || toolName === TASK_LIST_TOOL_NAME
    || toolName === TASK_UPDATE_TOOL_NAME
}

function messageRecordToDisplayItem(
  record: Extract<SessionRecord, { type: 'message' }>,
  thinkingDurationMs?: number,
): TUIDisplayItem {
  return {
    kind: record.role === 'user' ? 'user' : record.role === 'assistant' ? 'assistant' : 'system',
    id: record.id,
    content: record.displayContent ?? record.content,
    ...(record.role === 'assistant' && record.thinkingBlocks && record.thinkingBlocks.length > 0
      ? { thinkingBlocks: record.thinkingBlocks, thinkingDurationMs }
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

function isStreamingThinkingPreview(item: TUIDisplayItem): boolean {
  return item.kind === 'assistant'
    && item.content === ''
    && (!item.thinkingBlocks || item.thinkingBlocks.length === 0)
}
