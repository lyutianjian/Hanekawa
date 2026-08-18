import type { SessionRecord } from '../../../harness/types.js'
import type { SessionEvent } from '../../../runtime/sessionController.js'

/**
 * The transcript as data: a list of items plus whatever is still in flight.
 *
 * This is the DOM counterpart of `src/tui/transcript.ts`, and it is much
 * smaller for one reason — Ink's `<Static>` output cannot be retracted once a
 * later sibling is emitted, so the terminal has to partition items into
 * static/live and promote them in a strict order. A DOM node can simply be
 * replaced, so a streaming draft is just an item flagged `pending` that a later
 * record overwrites.
 *
 * `applySessionEvent` is exhaustive over `SessionEvent` with an `assertNever`
 * tail, so a new variant on the controller is a compile error here rather than
 * an event the desktop silently drops (which is exactly what shipped before:
 * six of the ten were ignored).
 *
 * DOM-free on purpose — `test/` imports this, and that puts it in the base
 * tsconfig program, which has no DOM lib.
 */

export type TranscriptItemKind =
  | 'user'
  | 'assistant'
  | 'thinking'
  | 'tool'
  | 'notice'
  | 'error'
  | 'subagent'
  | 'duration'

export interface TranscriptItem {
  /** Stable within a state: a record id, or a synthetic key for live items. */
  readonly id: string
  readonly kind: TranscriptItemKind
  readonly text: string
  /** Still arriving: a streaming draft, or a tool with no result yet. */
  readonly pending?: boolean
  readonly failed?: boolean
  readonly toolName?: string
}

export interface TranscriptState {
  readonly items: readonly TranscriptItem[]
  /** Bumped by a `transcript-reset` that asked for one; a view may use it as a key. */
  readonly generation: number
  /** In-flight tool summary line, from `tool-progress`. */
  readonly toolProgress: string | undefined
  readonly isThinking: boolean
}

/** What the caller must act on outside the transcript itself. */
export interface TranscriptOutcome {
  readonly state: TranscriptState
  /**
   * An interrupted prompt the controller rolled back. The composer has to take
   * this back or the user's message is destroyed — the record is already gone
   * from disk by the time this arrives.
   */
  readonly restoreInput?: string
  /** A model switch the loop performed by itself (fallback activation). */
  readonly activeModel?: string
}

const DRAFT_ID = '__draft__'
const THINKING_ID = '__thinking__'
/** Thinking is a peek, not a transcript entry; keep the tail bounded. */
export const THINKING_PREVIEW_CHARS = 240

export function createTranscriptState(records: readonly SessionRecord[] = []): TranscriptState {
  return {
    items: records.flatMap(recordItems),
    generation: 0,
    toolProgress: undefined,
    isThinking: false,
  }
}

export function applySessionEvent(state: TranscriptState, event: SessionEvent): TranscriptOutcome {
  switch (event.type) {
    case 'turn-start':
      // The user message arrives as a record too, but only after the turn has
      // done its first I/O; showing it now is what makes Enter feel immediate.
      return {
        state: {
          ...state,
          items: [...state.items, { id: event.messageId, kind: 'user', text: event.displayInput }],
          isThinking: false,
        },
      }

    case 'record':
      return { state: applyRecord(state, event.record) }

    case 'stream':
      return { state: applyStream(state, event.event) }

    case 'tool-progress':
      return { state: { ...state, toolProgress: event.listContent } }

    case 'notice':
      return {
        state: {
          ...state,
          items: [...state.items, {
            id: `notice-${state.items.length}`,
            kind: event.level === 'error' ? 'error' : 'notice',
            text: event.content,
          }],
        },
      }

    case 'transcript-reset': {
      const base = createTranscriptState(event.records)
      return {
        state: {
          ...base,
          items: [
            ...base.items,
            ...event.systemMessages.map((text, index) => ({
              id: `reset-notice-${index}`,
              kind: 'notice' as const,
              text,
            })),
          ],
          generation: event.bumpGeneration ? state.generation + 1 : state.generation,
        },
      }
    }

    case 'restore-input':
      return { state, restoreInput: event.text }

    case 'active-model':
      return { state, activeModel: event.model.model }

    case 'turn-end': {
      // Drop a draft that never became a record (an aborted or failed turn), or
      // it would sit there looking like it was still arriving.
      const items = state.items.filter((item) => item.id !== DRAFT_ID && item.id !== THINKING_ID)
      const summary = formatTurnSummary(event)
      return {
        state: {
          ...state,
          items: summary
            ? [...items, { id: `duration-${items.length}`, kind: 'duration', text: summary }]
            : items,
          toolProgress: undefined,
          isThinking: false,
        },
      }
    }
  }

  // Not a `default` branch, and it must not become one: this is what makes a new
  // `SessionEvent` variant a compile error instead of a silently dropped event.
  return assertNever(event)
}

/**
 * `aborted` is the signal's state, not "did it throw" — a *failed* turn is not
 * aborted and still gets its duration line, matching the TUI.
 */
export function formatTurnSummary(event: Extract<SessionEvent, { type: 'turn-end' }>): string | undefined {
  if (event.aborted) return undefined
  const seconds = Math.max(0, Math.round(event.durationMs / 100) / 10)
  return `Worked for ${seconds}s`
}

function applyStream(state: TranscriptState, event: Extract<SessionEvent, { type: 'stream' }>['event']): TranscriptState {
  switch (event.type) {
    case 'text_delta':
      return {
        ...state,
        isThinking: false,
        items: appendToLive(state.items, DRAFT_ID, 'assistant', event.text),
      }
    case 'thinking_delta':
      return {
        ...state,
        isThinking: true,
        items: appendToLive(state.items, THINKING_ID, 'thinking', event.thinking, THINKING_PREVIEW_CHARS),
      }
    case 'thinking_stop':
      return { ...state, isThinking: false }
    case 'message_start':
      // A second request within one turn (a tool round trip) starts a new
      // block; the previous draft has already been replaced by its record.
      return { ...state, items: state.items.filter((item) => item.id !== DRAFT_ID) }
    default:
      return state
  }
}

/**
 * Appends to the live item of that id, creating it if absent.
 *
 * `maxChars` keeps the *tail*, because a thinking peek is only interesting where
 * it currently is.
 */
function appendToLive(
  items: readonly TranscriptItem[],
  id: string,
  kind: TranscriptItemKind,
  text: string,
  maxChars?: number,
): TranscriptItem[] {
  const index = items.findIndex((item) => item.id === id)
  if (index === -1) {
    return [...items, { id, kind, text: clampTail(text, maxChars), pending: true }]
  }
  const next = [...items]
  const existing = next[index]!
  next[index] = { ...existing, text: clampTail(existing.text + text, maxChars) }
  return next
}

function clampTail(text: string, maxChars?: number): string {
  if (maxChars === undefined || text.length <= maxChars) return text
  return `…${text.slice(text.length - maxChars)}`
}

function applyRecord(state: TranscriptState, record: SessionRecord): TranscriptState {
  const items = recordItems(record)
  if (items.length === 0) return state

  // An assistant message *replaces* the streamed draft rather than following it.
  // Appending both is the duplicate-bubble bug the terminal avoids by never
  // committing a live message twice.
  const withoutDraft = record.type === 'message' && record.role !== 'user'
    ? state.items.filter((item) => item.id !== DRAFT_ID && item.id !== THINKING_ID)
    : state.items

  // A tool_result supersedes the pending tool_use row it answers.
  if (record.type === 'tool_result') {
    const pendingIndex = withoutDraft.findIndex((item) => item.id === record.toolUseId)
    if (pendingIndex !== -1) {
      const next = [...withoutDraft]
      next[pendingIndex] = items[0]!
      return { ...state, items: next }
    }
  }

  // Idempotent by id. The user's message is already on screen: `turn-start`
  // placed it there under `event.messageId`, and that id *is* the record id
  // (`SessionController.submit` mints it and `AgentLoop.runInternal` uses it
  // verbatim), so appending the record would draw the same bubble twice — the
  // duplicate the desktop smoke test found. Replacing rather than dropping,
  // because the record carries `displayContent`, which is the authoritative
  // text (a skill command's `displayInput` arrives only this way).
  const next = [...withoutDraft]
  for (const item of items) {
    const index = next.findIndex((existing) => existing.id === item.id)
    if (index === -1) next.push(item)
    else next[index] = item
  }
  return { ...state, items: next }
}

/** One record to zero or more items. Records with no visual meaning yield none. */
function recordItems(record: SessionRecord): TranscriptItem[] {
  switch (record.type) {
    case 'message':
      return [{
        id: record.id,
        kind: record.role === 'user' ? 'user' : 'assistant',
        text: messageText(record),
      }]

    case 'tool_use':
      return [{
        id: record.id,
        kind: 'tool',
        text: toolCallSummary(record.tool, record.input),
        toolName: record.tool,
        pending: true,
      }]

    case 'tool_result':
      return [{
        // Keyed by the call it answers, so it can replace that row in place.
        id: record.toolUseId,
        kind: 'tool',
        text: toolResultSummary(record.tool, record.ok, record.content),
        toolName: record.tool,
        ...(record.ok ? {} : { failed: true }),
      }]

    case 'subagent_task':
      return [{
        id: record.id,
        kind: 'subagent',
        text: `${record.subagentType}: ${record.status}${record.description ? ` — ${record.description}` : ''}`,
      }]

    case 'subagent_transcript':
      return [{
        id: record.id,
        kind: 'subagent',
        text: `${record.subagentType} finished${record.summary ? `: ${record.summary}` : ''}`,
      }]

    case 'turn_interruption':
      return [{ id: record.id, kind: 'notice', text: 'Interrupted.' }]

    case 'compact_boundary':
      return [{ id: record.id, kind: 'notice', text: 'Context compacted.' }]

    case 'compact_attempt_failed':
      return [{ id: record.id, kind: 'error', text: `Compaction failed: ${record.error}` }]

    default:
      // tool_approval, at_mention_context, tool_use_summary, background_task,
      // plan_mode_* and message_queue are bookkeeping, not transcript.
      return []
  }
}

/** Text blocks only; an image block has no textual form to show here. */
export function messageText(record: Extract<SessionRecord, { type: 'message' }>): string {
  const content: unknown = record.displayContent ?? record.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((block: unknown) => {
        if (typeof block !== 'object' || block === null) return ''
        const typed = block as { type?: string; text?: string }
        return typed.type === 'text' && typeof typed.text === 'string' ? typed.text : ''
      })
      .filter(Boolean)
      .join('\n')
  }
  return content === undefined ? '' : JSON.stringify(content)
}

/** `Tool(the most identifying argument)`, the way a transcript line reads best. */
export function toolCallSummary(tool: string, input: unknown): string {
  const detail = toolCallDetail(input)
  return detail ? `${tool}(${detail})` : tool
}

function toolCallDetail(input: unknown): string {
  if (typeof input !== 'object' || input === null) return ''
  const record = input as Record<string, unknown>
  for (const key of ['command', 'filePath', 'pattern', 'path', 'url', 'description', 'prompt']) {
    const value = record[key]
    if (typeof value === 'string' && value.length > 0) return truncate(value, 120)
  }
  return ''
}

function toolResultSummary(tool: string, ok: boolean, content: string): string {
  const firstLine = content.split('\n').find((line) => line.trim().length > 0) ?? ''
  const detail = truncate(firstLine.trim(), 160)
  if (!ok) return `${tool} failed${detail ? `: ${detail}` : ''}`
  return detail ? `${tool} → ${detail}` : `${tool} → done`
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value
}

function assertNever(value: never): never {
  throw new Error(`Unhandled session event: ${JSON.stringify(value)}`)
}
