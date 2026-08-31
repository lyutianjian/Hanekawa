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
  /**
   * A sealed thinking block's header label — this turn's elapsed time. `text` is
   * the reasoning itself, so the two cannot share a field.
   */
  readonly summary?: string
}

export interface TranscriptState {
  readonly items: readonly TranscriptItem[]
  /** Bumped by a `transcript-reset` that asked for one; a view may use it as a key. */
  readonly generation: number
  /** In-flight tool summary line, from `tool-progress`. */
  readonly toolProgress: string | undefined
  readonly isThinking: boolean
  /**
   * How many thinking blocks this state has ever minted, and the source of their
   * ids. **Not** `items.length`: `turn-end` drops the draft, so the list shrinks
   * and two blocks could be minted at the same length — one toggle would then
   * fold both.
   */
  readonly thinkingCount: number
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

export function createTranscriptState(records: readonly SessionRecord[] = []): TranscriptState {
  return {
    items: records.flatMap(recordItems),
    generation: 0,
    toolProgress: undefined,
    isThinking: false,
    thinkingCount: 0,
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
      // it would sit there looking like it was still arriving. Thinking is *not*
      // dropped any more: it becomes this turn's collapsible header, and the
      // summary it carries is why no separate duration line follows.
      const kept = state.items.filter((item) => item.id !== DRAFT_ID)
      const summary = formatTurnSummary(event)
      const { items, sealed } = sealThinking(kept, summary)
      return {
        state: {
          ...state,
          items: summary && !sealed
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
  return `已处理 ${formatWorkedDuration(event.durationMs)}`
}

/**
 * `7m 38s`, the shape `design_guidance.md` asks the collapsed thinking header for,
 * and the same one the TUI's own elapsed line uses.
 *
 * Sub-second turns keep a tenth, because `已处理 0s` reads as a broken clock. Above
 * a second the fraction is noise, so it floors.
 */
export function formatWorkedDuration(ms: number): string {
  const total = Math.max(0, ms) / 1000
  if (total < 1) return `${Math.round(total * 10) / 10}s`
  const seconds = Math.floor(total)
  const minutes = Math.floor(seconds / 60)
  return minutes > 0 ? `${minutes}m ${seconds % 60}s` : `${seconds}s`
}

/**
 * Closes the turn's thinking block: clears `pending` (which is what the view reads
 * as "collapse me now") and hands the last one the turn's elapsed time.
 *
 * Only one block can be pending at a time — `appendThinking` appends to it rather
 * than minting a second — but the sweep is written over all of them so a block that
 * somehow missed its `turn-end` is closed by the next one instead of breathing
 * forever.
 */
function sealThinking(
  items: readonly TranscriptItem[],
  summary: string | undefined,
): { items: TranscriptItem[]; sealed: boolean } {
  const last = lastPendingThinking(items)
  if (last === -1) return { items: [...items], sealed: false }
  return {
    items: items.map((item, index) => {
      if (item.kind !== 'thinking' || item.pending !== true) return item
      const closed: TranscriptItem = { id: item.id, kind: item.kind, text: item.text }
      return index === last && summary ? { ...closed, summary } : closed
    }),
    sealed: true,
  }
}

function lastPendingThinking(items: readonly TranscriptItem[]): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]!
    if (item.kind === 'thinking' && item.pending === true) return index
  }
  return -1
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
      return appendThinking(state, event.thinking)
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
 */
function appendToLive(
  items: readonly TranscriptItem[],
  id: string,
  kind: TranscriptItemKind,
  text: string,
): TranscriptItem[] {
  const index = items.findIndex((item) => item.id === id)
  if (index === -1) {
    return [...items, { id, kind, text, pending: true }]
  }
  const next = [...items]
  const existing = next[index]!
  next[index] = { ...existing, text: existing.text + text }
  return next
}

/**
 * Thinking is grouped by **the open block**, not by turn identity: a delta extends
 * the last still-pending thinking item, and only mints a new one when there is
 * none. `turn-end` is what closes one, so the next turn's first delta necessarily
 * starts a fresh block — no turn id has to be carried in the state, and a
 * `transcript-reset` mid-turn cannot leave the grouping keyed to a turn that is
 * gone.
 *
 * The consequence, accepted: a second block after a tool round trip joins the one
 * above those tool rows instead of reading where it happened. One block per turn is
 * what lets a single collapsed header own the turn's elapsed time.
 */
function appendThinking(state: TranscriptState, text: string): TranscriptState {
  const index = lastPendingThinking(state.items)
  if (index === -1) {
    return {
      ...state,
      isThinking: true,
      thinkingCount: state.thinkingCount + 1,
      items: [...state.items, {
        id: `thinking-${state.thinkingCount}`,
        kind: 'thinking',
        text,
        pending: true,
      }],
    }
  }
  const items = [...state.items]
  const existing = items[index]!
  items[index] = { ...existing, text: existing.text + text }
  return { ...state, isThinking: true, items }
}

function applyRecord(state: TranscriptState, record: SessionRecord): TranscriptState {
  const items = recordItems(record)
  if (items.length === 0) return state

  // An assistant message *replaces* the streamed draft rather than following it.
  // Appending both is the duplicate-bubble bug the terminal avoids by never
  // committing a live message twice. The turn's thinking block stays: it is closed
  // by `turn-end`, not by the message it was reasoning towards.
  const withoutDraft = record.type === 'message' && record.role !== 'user'
    ? state.items.filter((item) => item.id !== DRAFT_ID)
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

/** Mirror of `wrapInSystemReminder`'s output (`src/harness/systemReminder.ts`).
 * The renderer may not import `harness/`, so the format check is duplicated here. */
function isSystemReminderBlock(text: string): boolean {
  const trimmed = text.trim()
  return trimmed.startsWith('<system-reminder>') && trimmed.endsWith('</system-reminder>')
}

/** One record to zero or more items. Records with no visual meaning yield none. */
function recordItems(record: SessionRecord): TranscriptItem[] {
  switch (record.type) {
    case 'message':
      // A `<system-reminder>` user record is a model-facing nudge, not user input;
      // it must not surface as a bubble, so it yields no item.
      if (record.role === 'user' && isSystemReminderBlock(messageText(record))) return []
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
