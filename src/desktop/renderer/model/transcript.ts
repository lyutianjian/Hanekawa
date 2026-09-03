import type { SessionRecord, ToolResultDisplay } from '../../../harness/types.js'
import type { SessionEvent } from '../../../runtime/sessionController.js'
import type { ToolDisplayDto } from '../../../runtime/protocol/wire.js'

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
 *
 * ## Activity groups
 *
 * The decision `activity_group_tasks.md` T2 asks to fix, so nothing downstream
 * reopens it: **`items` stays the single authoritative list, and the activity
 * group tree is a pure derivation over it** (`groupTranscript`). It is not a
 * second structure the fold has to keep in step.
 *
 * That is what makes §4.2's symmetry cheap rather than a standing risk: live and
 * replay agree on the group tree exactly when they agree on `items`, which is one
 * property to test instead of two code paths to keep aligned. Every fact a group
 * needs therefore rides on an item — `turnId` (the grouping key, §4.1),
 * `createdAt` (the fallback span), `durationMs` on the turn's `duration` item (the
 * authoritative elapsed time), `interrupt` (an aborted turn).
 *
 * ## Live and replay produce the *same* items (§4.2, T3)
 *
 * Two rules buy that equality, and both are load-bearing:
 *
 * 1. **A thinking segment is one model request.** `message_start` closes the open
 *    segment and the next `thinking_delta` opens a new one, which is the shape
 *    `thinkingBlocks` replays into. (Before T3 a whole turn appended into one
 *    block, so the segment count itself differed between the two paths.)
 * 2. **The assistant record supersedes what streamed, in place.** The draft text
 *    and the open thinking segment are the same reasoning the record persists, so
 *    the record's items overwrite them at their existing positions — same order,
 *    and the same *ids*, which is what lets an open/closed toggle survive the
 *    commit and what makes the two trees compare field-for-field.
 *
 * Live items are stamped with `turnId` from the records already seen this turn, so
 * a streaming segment joins its group before the turn ends. §4.6's demotion of a
 * tentative final answer then needs no code of its own: `groupTranscript` keeps
 * only the run's *last* assistant text outside the group, so a `tool_use` arriving
 * after it moves it inside by itself.
 *
 * ## A tool is one step, not two rows (§4.5, T4)
 *
 * `tool_use` and `tool_result` share one item, keyed by the call's id, and the
 * result *merges into* the call rather than replacing it — the caption, the
 * arguments and the start time all live on the call side and are still what the
 * collapsed head reads after the result lands. The elapsed time falls out of the
 * two `createdAt`s, so no record gained a field for it.
 *
 * The caption itself is not guessed here any more: `ToolDisplayDto` is projected
 * host-side from `src/tools/display.ts` (T1), which is the same source the TUI
 * reads, and a lookup is handed in by the caller. Without one — an older host —
 * the previous key-guessing (`toolCallSummary` / `toolResultSummary`) still runs,
 * so an old client degrades rather than showing raw JSON.
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

/**
 * How the host captions a `tool_use` record, by record id.
 *
 * A function rather than the map itself: `SessionClient` accumulates captions as
 * payloads arrive and a `tool_result` ten seconds later is drawn under the same
 * header, so the fold has to ask at the moment it builds the item.
 */
export type ToolDisplayLookup = (recordId: string) => ToolDisplayDto | undefined

/** §3's four states. The colour is never the only carrier; see `toolStatusLabel`. */
export type ToolStepStatus = 'awaiting-approval' | 'running' | 'done' | 'failed'

/**
 * Everything a tool step's head and body need, gathered from both records.
 *
 * The call side (`displayName`, `useSummary`, `startedAt`) survives the result
 * merging in; the result side adds `headerSuffix`, the body, and the elapsed time.
 */
export interface ToolStepDetail {
  /** `Tool.userFacingName(input)` via the DTO, else the raw tool name. */
  readonly displayName: string
  /** `Tool.getToolUseSummary(input)` via the DTO, else the guessed argument. */
  readonly useSummary: string
  /** `ToolResultDisplay.headerSuffix` — the result's own trailing note. */
  readonly headerSuffix?: string
  /** `ToolResultDisplay.summary` — the expanded body's own header (§6.2 兜底). */
  readonly resultSummary?: string
  /** `ToolResultDisplay.detail`; the body prefers it over `content`. */
  readonly detail?: string
  /** The raw `tool_result.content`, the body's fallback. */
  readonly content?: string
  /** `tool_use.createdAt`, kept so a late result can still measure the span. */
  readonly startedAt?: string
  /** `tool_result.createdAt − tool_use.createdAt`; absent if either is unparseable. */
  readonly durationMs?: number
  /** The call has a `tool_use` record but no approval yet (§3). */
  readonly awaitingApproval?: boolean
  /** `TodoWrite` only: the `3/6` the head shows (§4.4). */
  readonly progress?: { readonly completed: number; readonly total: number }
  /**
   * The caption came from the host DTO rather than from guessing at `input`.
   *
   * It decides whether the result may rewrite the collapsed line: a captioned
   * step keeps the call's head and puts the result in its body, while a DTO-less
   * one falls back to the old `Read → contents` single line.
   */
  readonly captioned?: boolean
}

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
  /** The activity group this item belongs to (§4.1). Absent = outside every group. */
  readonly turnId?: string
  /** The originating record's timestamp; the fallback source of a group's duration. */
  readonly createdAt?: string
  /** On a `duration` item: the turn's measured elapsed time, in ms. */
  readonly durationMs?: number
  /** On the notice minted by a `turn_interruption`: this turn was aborted. */
  readonly interrupt?: boolean
  /** On a `tool` item: both records' worth of head and body (§4.5). */
  readonly tool?: ToolStepDetail
}

/** One step inside an activity group. `text` is the body; heads are the view's job. */
export type ActivityStep =
  | { readonly kind: 'thinking'; readonly id: string; readonly text: string; readonly pending?: boolean; readonly summary?: string }
  | {
      readonly kind: 'tool'
      readonly id: string
      readonly text: string
      readonly toolName?: string
      readonly pending?: boolean
      readonly failed?: boolean
      readonly status: ToolStepStatus
      readonly tool: ToolStepDetail
    }
  | { readonly kind: 'text'; readonly id: string; readonly text: string }
  | { readonly kind: 'subagent'; readonly id: string; readonly text: string; readonly pending?: boolean }
  | { readonly kind: 'system'; readonly id: string; readonly text: string; readonly failed?: boolean }
  // `TodoWrite`: a single line that never expands — the list itself lives in the
  // task panel above the composer (§4.4, §7).
  | {
      readonly kind: 'task'
      readonly id: string
      readonly text: string
      readonly toolName?: string
      readonly pending?: boolean
      readonly failed?: boolean
      readonly status: ToolStepStatus
      readonly tool: ToolStepDetail
    }

export interface ActivityGroup {
  /** The grouping key, and the group's stable id. */
  readonly turnId: string
  readonly steps: readonly ActivityStep[]
  readonly status: 'running' | 'done' | 'aborted'
  readonly durationMs?: number
  readonly stepCount: number
  readonly failedCount: number
}

/**
 * The transcript as the view reads it: loose items (user messages, the final
 * answer, turn-less notices) interleaved with activity groups, in order.
 */
export type TranscriptEntry =
  | { readonly kind: 'item'; readonly item: TranscriptItem }
  | { readonly kind: 'group'; readonly group: ActivityGroup }

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
  /**
   * The turn whose records are arriving — the stamp live items inherit so they
   * join their activity group before `turn-end` (§4.1). Learned from the records
   * themselves; cleared when the turn ends.
   */
  readonly turnId?: string
  /**
   * The thinking segment `thinking_delta` extends. `message_start` closes it and
   * the assistant record replaces it, so «which segment is open» is explicit
   * rather than inferred from `pending` — the last *sealed* block would otherwise
   * be reopened by the next request's first delta (§4.2).
   */
  readonly liveThinkingId?: string
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

export function createTranscriptState(
  records: readonly SessionRecord[] = [],
  toolDisplays?: ToolDisplayLookup,
): TranscriptState {
  // Approvals are matched over the *records*, in order, not over the items: the
  // approval record names no `tool_use`, so the only honest link is «the earliest
  // unanswered call of that tool». Matching over collapsed items would let a
  // finished call's approval clear a later, still-waiting one of the same name.
  const context: ItemContext = { toolDisplays, approved: approvedToolUseIds(records) }
  return {
    items: mergeAdjacentThinking(collapseById(records.flatMap((record) => recordItems(record, context)))),
    generation: 0,
    toolProgress: undefined,
    isThinking: false,
    thinkingCount: 0,
  }
}

export function applySessionEvent(
  state: TranscriptState,
  event: SessionEvent,
  toolDisplays?: ToolDisplayLookup,
): TranscriptOutcome {
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
      return { state: applyRecord(state, event.record, toolDisplays) }

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
      const base = createTranscriptState(event.records, toolDisplays)
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
      // dropped: it is this turn's reasoning, and it stays as steps.
      //
      // The measured elapsed time rides on a `duration` item stamped with the
      // turn, which `groupTranscript` folds into the group head rather than
      // drawing as a row (§5.3). It is minted unconditionally now — before T3 a
      // turn that thought suppressed it and handed the total to the last thinking
      // block instead, which under §4.2's segmentation would pin a whole turn's
      // time to whichever request happened to reason last.
      const items = closeThinkingSegments(state.items.filter((item) => item.id !== DRAFT_ID))
      const summary = formatTurnSummary(event)
      return {
        state: {
          ...state,
          items: summary
            ? [...items, {
                id: `duration-${items.length}`,
                kind: 'duration',
                text: summary,
                durationMs: event.durationMs,
                ...(state.turnId === undefined ? {} : { turnId: state.turnId }),
              }]
            : items,
          toolProgress: undefined,
          isThinking: false,
          turnId: undefined,
          liveThinkingId: undefined,
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
 * Closes every open thinking segment: clears `pending`, which is what the view
 * reads as "stop breathing, collapse me".
 *
 * Written as a sweep rather than a lookup of the open one, so a segment that
 * somehow missed its `message_start` is closed by the next `turn-end` instead of
 * breathing forever.
 */
function closeThinkingSegments(items: readonly TranscriptItem[]): TranscriptItem[] {
  return items.map((item) => (item.kind === 'thinking' && item.pending === true ? closeSegment(item) : item))
}

function closeSegment(item: TranscriptItem): TranscriptItem {
  const { pending: _pending, ...closed } = item
  return closed
}

function applyStream(state: TranscriptState, event: Extract<SessionEvent, { type: 'stream' }>['event']): TranscriptState {
  switch (event.type) {
    case 'text_delta':
      return {
        ...state,
        isThinking: false,
        items: appendToLive(state.items, DRAFT_ID, 'assistant', event.text, state.turnId),
      }
    case 'thinking_delta':
      return appendThinking(state, event.thinking)
    case 'thinking_stop':
      return { ...state, isThinking: false }
    case 'message_start':
      // One model request is one thinking segment (§4.2): a second request within
      // the turn — a tool round trip — closes the open segment and the next delta
      // opens a fresh one, which is exactly what replaying `thinkingBlocks` per
      // record produces. The previous draft has already been replaced by its
      // record; the filter only catches a request that produced no message at all.
      return {
        ...state,
        items: closeThinkingSegments(state.items.filter((item) => item.id !== DRAFT_ID)),
        liveThinkingId: undefined,
      }
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
  turnId: string | undefined,
): TranscriptItem[] {
  const index = items.findIndex((item) => item.id === id)
  if (index === -1) {
    return [...items, { id, kind, text, pending: true, ...(turnId === undefined ? {} : { turnId }) }]
  }
  const next = [...items]
  const existing = next[index]!
  next[index] = { ...existing, text: existing.text + text }
  return next
}

/**
 * A delta extends the segment `liveThinkingId` names, and mints a new one when
 * there is none open — which is the state `message_start`, the committing record
 * and `turn-end` all leave behind. Keying on an explicit id rather than on "the
 * last pending block" is what makes a *closed* segment stay closed: a delta after
 * a tool round trip has to start a second segment, not reopen the first (§4.2).
 *
 * A `transcript-reset` rebuilds the state, so the id cannot outlive the items it
 * points at.
 */
function appendThinking(state: TranscriptState, text: string): TranscriptState {
  const index = state.liveThinkingId === undefined
    ? -1
    : state.items.findIndex((item) => item.id === state.liveThinkingId)
  if (index === -1) {
    const id = `thinking-${state.thinkingCount}`
    return {
      ...state,
      isThinking: true,
      thinkingCount: state.thinkingCount + 1,
      liveThinkingId: id,
      items: [...state.items, {
        id,
        kind: 'thinking',
        text,
        pending: true,
        ...(state.turnId === undefined ? {} : { turnId: state.turnId }),
      }],
    }
  }
  const items = [...state.items]
  const existing = items[index]!
  items[index] = { ...existing, text: existing.text + text }
  return { ...state, isThinking: true, items }
}

function applyRecord(
  state: TranscriptState,
  record: SessionRecord,
  toolDisplays: ToolDisplayLookup | undefined,
): TranscriptState {
  // Live items inherit the turn from the records already seen, so a streaming
  // segment is inside its group before `turn-end` names the turn (§4.1).
  const turnId = recordStamp(record).turnId ?? state.turnId

  // The approval is bookkeeping — it draws nothing — but it is what moves a call
  // out of 「等待授权」. Live it needs no queue: the call it belongs to is simply
  // the earliest one of that tool still waiting, because a second call of the
  // same tool cannot be recorded while this one holds the gate.
  if (record.type === 'tool_approval') {
    return { ...state, turnId, items: clearAwaitingApproval(state.items, record) }
  }

  const produced = recordItems(record, { toolDisplays })
  if (produced.length === 0) return { ...state, turnId }

  // An assistant message *replaces* what streamed rather than following it.
  // Appending both is the duplicate-bubble bug the terminal avoids by never
  // committing a live message twice.
  const commits = record.type === 'message' && record.role !== 'user'
  const next = commits ? state.items.filter((item) => item.id !== DRAFT_ID) : [...state.items]
  const pending = [...produced]
  let liveThinkingId = state.liveThinkingId

  if (commits) {
    // The open segment and this record's `thinkingBlocks` are the same reasoning.
    // Overwriting in place keeps the position *and* the id it replays under, which
    // is what makes the live tree and the replayed tree comparable field by field
    // — and what keeps a toggle the user set mid-stream pointing at the same step.
    const open = liveThinkingId === undefined ? -1 : next.findIndex((item) => item.id === liveThinkingId)
    if (open !== -1) {
      const replayed = pending.findIndex((item) => item.kind === 'thinking')
      // No persisted blocks (thinking off, or an older provider): keep what
      // streamed and merely close it, rather than deleting reasoning that is real.
      next[open] = replayed === -1 ? closeSegment(next[open]!) : pending.splice(replayed, 1)[0]!
    }
    liveThinkingId = undefined
  }

  // A tool_result *merges into* the call row it answers — it does not replace it
  // (§4.5). The caption and the start time only exist on the call side.
  if (record.type === 'tool_result') {
    const answered = next.findIndex((item) => item.id === record.toolUseId)
    if (answered !== -1) {
      next[answered] = mergeToolItems(next[answered]!, pending[0]!)
      return { ...state, turnId, liveThinkingId, items: next }
    }
  }

  // Idempotent by id. The user's message is already on screen: `turn-start`
  // placed it there under `event.messageId`, and that id *is* the record id
  // (`SessionController.submit` mints it and `AgentLoop.runInternal` uses it
  // verbatim), so appending the record would draw the same bubble twice — the
  // duplicate the desktop smoke test found. Replacing rather than dropping,
  // because the record carries `displayContent`, which is the authoritative
  // text (a skill command's `displayInput` arrives only this way).
  for (const item of pending) {
    const index = next.findIndex((existing) => existing.id === item.id)
    if (index === -1) next.push(item)
    else next[index] = item
  }
  // §4.3 again, on the live path: two requests in a row that called nothing are
  // one segment, and replay merges them, so this path has to as well.
  return { ...state, turnId, liveThinkingId, items: mergeAdjacentThinking(next) }
}

/** Mirror of `wrapInSystemReminder`'s output (`src/harness/systemReminder.ts`).
 * The renderer may not import `harness/`, so the format check is duplicated here. */
function isSystemReminderBlock(text: string): boolean {
  const trimmed = text.trim()
  return trimmed.startsWith('<system-reminder>') && trimmed.endsWith('</system-reminder>')
}

interface ItemContext {
  readonly toolDisplays?: ToolDisplayLookup
  /** Replay only: `tool_use` ids an approval record has already answered. */
  readonly approved?: ReadonlySet<string>
}

/** One record to zero or more items. Records with no visual meaning yield none. */
function recordItems(record: SessionRecord, context: ItemContext = {}): TranscriptItem[] {
  const stamp = recordStamp(record)
  switch (record.type) {
    case 'message': {
      // A `<system-reminder>` user record is a model-facing nudge, not user input;
      // it must not surface as a bubble, so it yields no item.
      if (record.role === 'user' && isSystemReminderBlock(messageText(record))) return []
      const text: TranscriptItem = {
        id: record.id,
        kind: record.role === 'user' ? 'user' : 'assistant',
        text: messageText(record),
        ...stamp,
      }
      // One model request = one thinking segment ahead of its text (§4.2). Old
      // sessions have no `thinkingBlocks`, and that degrades silently (§10).
      const thinking = replayedThinking(record)
      return thinking ? [{ ...thinking, ...stamp }, text] : [text]
    }

    case 'tool_use': {
      const dto = context.toolDisplays?.(record.id)
      const tool: ToolStepDetail = {
        displayName: dto?.displayName ?? record.tool,
        useSummary: dto?.useSummary ?? toolCallDetail(record.input),
        ...(record.createdAt === undefined ? {} : { startedAt: record.createdAt }),
        // Recorded, not yet approved. The approval record clears it; a call the
        // gate waved through clears it just as fast, so the state is only ever
        // visible for as long as the user is actually being asked.
        ...(context.approved?.has(record.id) === true ? {} : { awaitingApproval: true }),
        ...(dto ? { captioned: true } : {}),
      }
      return [{
        id: record.id,
        kind: 'tool',
        // The DTO-less fallback keeps the shape older clients drew, `Read(a.txt)`.
        text: dto ? toolHeaderText(tool) : toolCallSummary(record.tool, record.input),
        toolName: record.tool,
        pending: true,
        tool,
        ...stamp,
      }]
    }

    case 'tool_result': {
      // Keyed by the call it answers, so it merges into that row in place.
      const tool = resultDetail(record.tool, record.display, record.content)
      return [{
        id: record.toolUseId,
        kind: 'tool',
        text: toolResultSummary(record.tool, record.ok, record.content),
        toolName: record.tool,
        ...(record.ok ? {} : { failed: true }),
        tool,
        ...stamp,
      }]
    }

    case 'subagent_task':
      return [{
        id: record.id,
        kind: 'subagent',
        text: `${record.subagentType}: ${record.status}${record.description ? ` — ${record.description}` : ''}`,
        ...stamp,
      }]

    case 'subagent_transcript':
      return [{
        id: record.id,
        kind: 'subagent',
        text: `${record.subagentType} finished${record.summary ? `: ${record.summary}` : ''}`,
        ...stamp,
      }]

    case 'turn_interruption':
      return [{ id: record.id, kind: 'notice', text: 'Interrupted.', interrupt: true, ...stamp }]

    case 'compact_boundary':
      return [{ id: record.id, kind: 'notice', text: 'Context compacted.', ...stamp }]

    case 'compact_attempt_failed':
      return [{ id: record.id, kind: 'error', text: `Compaction failed: ${record.error}`, ...stamp }]

    default:
      // tool_approval, at_mention_context, tool_use_summary, background_task,
      // plan_mode_* and message_queue are bookkeeping, not transcript.
      return []
  }
}

/** The head as one line: `Read src/a.ts`. Either half may be empty. */
function toolHeaderText(tool: ToolStepDetail): string {
  return [tool.displayName, tool.useSummary].filter((part) => part.length > 0).join(' ')
}

/**
 * The result half of a step. Deliberately carries no `displayName` /
 * `useSummary`: those belong to the call and `mergeToolItems` must not lose them
 * to a spread. A result with no call to merge into (a truncated log) still needs
 * *some* name, so it falls back to the raw tool name there.
 */
function resultDetail(toolName: string, display: ToolResultDisplay | undefined, content: string): ToolStepDetail {
  return {
    displayName: toolName,
    useSummary: '',
    content,
    ...(display?.headerSuffix === undefined ? {} : { headerSuffix: display.headerSuffix }),
    ...(display?.summary === undefined ? {} : { resultSummary: display.summary }),
    ...(display?.detail === undefined ? {} : { detail: display.detail }),
    ...(display?.taskSnapshot === undefined ? {} : {
      progress: {
        completed: display.taskSnapshot.counts.completed,
        total: display.taskSnapshot.counts.total,
      },
    }),
  }
}

/**
 * Call + result as one item (§4.5).
 *
 * The result's fields win *except* the caption and the start time, which only
 * the call has, and `awaitingApproval`, which a result settles by existing. The
 * head line survives only for a captioned step; without a DTO the old
 * `Read → contents` line is still the best single row available.
 */
function mergeToolItems(call: TranscriptItem, result: TranscriptItem): TranscriptItem {
  const callTool = call.tool
  const resultTool = result.tool
  if (callTool === undefined || resultTool === undefined) return result
  const { awaitingApproval: _awaiting, ...settled } = callTool
  const tool: ToolStepDetail = {
    ...settled,
    ...resultTool,
    displayName: callTool.displayName,
    useSummary: callTool.useSummary,
    ...spanBetween(callTool.startedAt, result.createdAt),
  }
  return {
    ...result,
    tool,
    ...(callTool.captioned === true ? { text: call.text } : {}),
  }
}

/** The tool's own elapsed time. Unparseable stamps (an old log, a test) yield none. */
function spanBetween(startedAt: string | undefined, finishedAt: string | undefined): { durationMs?: number } {
  const start = startedAt === undefined ? NaN : Date.parse(startedAt)
  const end = finishedAt === undefined ? NaN : Date.parse(finishedAt)
  if (!Number.isFinite(start) || !Number.isFinite(end)) return {}
  return { durationMs: Math.max(0, end - start) }
}

/**
 * Which `tool_use` records an approval has already answered (replay).
 *
 * `ToolApprovalRecord` names no call, so calls of the same tool are matched in
 * order — which is exact, because `ToolRunner` records the approval before the
 * next call of that tool can reach the gate. A host that does name the call
 * (`toolUseId`) is believed instead.
 */
function approvedToolUseIds(records: readonly SessionRecord[]): Set<string> {
  const approved = new Set<string>()
  const waiting = new Map<string, string[]>()
  for (const record of records) {
    if (record.type === 'tool_use') {
      const queue = waiting.get(record.tool)
      if (queue) queue.push(record.id)
      else waiting.set(record.tool, [record.id])
      continue
    }
    if (record.type !== 'tool_approval') continue
    const named = (record as { toolUseId?: unknown }).toolUseId
    if (typeof named === 'string') {
      approved.add(named)
      const queue = waiting.get(record.tool)
      if (queue) waiting.set(record.tool, queue.filter((id) => id !== named))
      continue
    }
    const next = waiting.get(record.tool)?.shift()
    if (next !== undefined) approved.add(next)
  }
  return approved
}

/** The live counterpart of `approvedToolUseIds`, one record at a time. */
function clearAwaitingApproval(
  items: readonly TranscriptItem[],
  record: Extract<SessionRecord, { type: 'tool_approval' }>,
): readonly TranscriptItem[] {
  const named = (record as { toolUseId?: unknown }).toolUseId
  const index = items.findIndex((item) => (
    item.kind === 'tool'
    && item.tool?.awaitingApproval === true
    && (typeof named === 'string' ? item.id === named : item.toolName === record.tool)
  ))
  if (index === -1) return items
  const next = [...items]
  const { awaitingApproval: _awaiting, ...tool } = next[index]!.tool!
  next[index] = { ...next[index]!, tool }
  return next
}

/** Not every record variant declares `turnId`, and a few carry no clock either. */
function recordStamp(record: SessionRecord): { turnId?: string; createdAt?: string } {
  const fields = record as { turnId?: unknown; createdAt?: unknown }
  return {
    ...(typeof fields.turnId === 'string' ? { turnId: fields.turnId } : {}),
    ...(typeof fields.createdAt === 'string' ? { createdAt: fields.createdAt } : {}),
  }
}

/**
 * The persisted reasoning of one model request, as one thinking item.
 *
 * All of a request's blocks become a single segment: they are adjacent with no
 * tool between them, and §4.3 says that is one segment, not several.
 * `redacted_thinking` carries no readable text and drops out.
 */
function replayedThinking(record: Extract<SessionRecord, { type: 'message' }>): TranscriptItem | undefined {
  const text = (record.thinkingBlocks ?? [])
    .map((block) => (typeof block.thinking === 'string' ? block.thinking : ''))
    .filter((value) => value.trim().length > 0)
    .join('\n\n')
  if (text.length === 0) return undefined
  return { id: `${record.id}-thinking`, kind: 'thinking', text }
}

/**
 * A `tool_result` keys itself by the call it answers, so replaying both records
 * yields two items under one id. The live fold merges the two in place
 * (`applyRecord`); replay has to do the same, or the same call draws twice — and
 * with the same *merge*, or replay would drop the caption the call carries.
 */
function collapseById(items: readonly TranscriptItem[]): TranscriptItem[] {
  const collapsed: TranscriptItem[] = []
  const seen = new Map<string, number>()
  for (const item of items) {
    const index = seen.get(item.id)
    if (index === undefined) {
      seen.set(item.id, collapsed.length)
      collapsed.push(item)
    } else {
      const previous = collapsed[index]!
      collapsed[index] = previous.kind === 'tool' && item.kind === 'tool'
        ? mergeToolItems(previous, item)
        : item
    }
  }
  return collapsed
}

/**
 * §4.3: adjacent thinking with no tool between it is one segment. Within a
 * request that is already true; this closes the case of two requests in a row
 * that called nothing (a retry, a continuation).
 *
 * An empty assistant text is the shape of a tool-only request and is not a
 * separator — nothing is drawn for it (§4.6), so thinking on either side of one
 * is still adjacent.
 *
 * A segment still streaming is left out of it: `liveThinkingId` names that one
 * item, and absorbing it into a neighbour would strand the id mid-stream. Replay
 * has nothing pending, so the rule costs it nothing.
 */
function mergeAdjacentThinking(items: readonly TranscriptItem[]): TranscriptItem[] {
  const merged: TranscriptItem[] = []
  for (const item of items) {
    const previous = item.kind === 'thinking' && item.pending !== true ? lastVisible(merged) : -1
    const target = previous === -1 ? undefined : merged[previous]!
    if (target && target.kind === 'thinking' && target.pending !== true && target.turnId === item.turnId) {
      merged[previous] = { ...target, text: `${target.text}\n\n${item.text}` }
    } else {
      merged.push(item)
    }
  }
  return merged
}

function lastVisible(items: readonly TranscriptItem[]): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]!
    if (item.kind === 'assistant' && item.text.trim().length === 0) continue
    return index
  }
  return -1
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

/**
 * Items to «loose item | activity group», in order (§2, §4.4).
 *
 * A group is one contiguous run of items sharing a `turnId`. Contiguity is what
 * keeps the projection order-preserving: were the same turn to appear twice with
 * something else between, hoisting the later half into the earlier group would
 * move rows the reader has already read.
 *
 * What leaves the group: the user's message, and the turn's final answer — the
 * last assistant text of the run, which §4.6 keeps outside as the only 「正文」.
 * A turn with no steps draws no empty group; its duration falls back to the
 * single line it is today (§5.3).
 */
export function groupTranscript(items: readonly TranscriptItem[]): TranscriptEntry[] {
  const entries: TranscriptEntry[] = []
  for (let index = 0; index < items.length;) {
    const turnId = items[index]!.turnId
    if (turnId === undefined) {
      entries.push({ kind: 'item', item: items[index]! })
      index += 1
      continue
    }
    let end = index
    while (end < items.length && items[end]!.turnId === turnId) end += 1
    entries.push(...turnEntries(turnId, items.slice(index, end)))
    index = end
  }
  return entries
}

function turnEntries(turnId: string, run: readonly TranscriptItem[]): TranscriptEntry[] {
  const before: TranscriptItem[] = []
  const after: TranscriptItem[] = []
  const body: TranscriptItem[] = []
  let duration: TranscriptItem | undefined

  for (const item of run) {
    if (item.kind === 'user') (body.length === 0 ? before : body).push(item)
    else if (item.kind === 'duration') duration = item
    // An empty assistant record is the shape of a tool-only request: no bubble.
    else if (item.kind === 'assistant' && item.text.trim().length === 0) continue
    else body.push(item)
  }
  // The final answer is the run's last item only when nothing followed it.
  const last = body[body.length - 1]
  if (last?.kind === 'assistant') { after.push(last); body.pop() }

  const steps = body.map(toStep)
  const entries: TranscriptEntry[] = before.map((item) => ({ kind: 'item' as const, item }))
  if (steps.length === 0) {
    // The single elapsed line goes where it has always gone: under the answer.
    entries.push(...after.map((item) => ({ kind: 'item' as const, item })))
    if (duration) entries.push({ kind: 'item', item: duration })
    return entries
  }

  // An interruption outranks a step still marked pending: the tool call the abort
  // cut off never gets a result, so "running" would be permanent. Both paths read
  // the same `turn_interruption` record, which is why live and replay agree —
  // `turn-end`'s own `aborted` flag is deliberately not consulted, replay has none.
  const interrupted = run.some((item) => item.interrupt === true)
  const running = steps.some((step) => 'pending' in step && step.pending === true)
  entries.push({
    kind: 'group',
    group: {
      turnId,
      steps,
      status: interrupted ? 'aborted' : running ? 'running' : 'done',
      ...durationOf(duration, run),
      stepCount: steps.length,
      failedCount: steps.filter((step) => (
        ('status' in step && step.status === 'failed') || ('failed' in step && step.failed === true)
      )).length,
    },
  })
  return [...entries, ...after.map((item) => ({ kind: 'item' as const, item }))]
}

/**
 * The measured elapsed time when the turn ended under this state, and otherwise
 * the span of the turn's records — a replayed turn has no `turn-end` to quote.
 */
function durationOf(duration: TranscriptItem | undefined, run: readonly TranscriptItem[]): { durationMs?: number } {
  if (duration?.durationMs !== undefined) return { durationMs: duration.durationMs }
  const stamps = run
    .map((item) => (item.createdAt === undefined ? NaN : Date.parse(item.createdAt)))
    .filter((value) => Number.isFinite(value))
  if (stamps.length < 2) return {}
  return { durationMs: Math.max(...stamps) - Math.min(...stamps) }
}

const TASK_TOOL = 'TodoWrite'

/**
 * §3's four states, in precedence order: a settled call is what it settled as,
 * and only an unsettled one distinguishes waiting for the user from running.
 */
export function toolStepStatus(item: TranscriptItem): ToolStepStatus {
  if (item.failed === true) return 'failed'
  if (item.pending !== true) return 'done'
  return item.tool?.awaitingApproval === true ? 'awaiting-approval' : 'running'
}

/**
 * The state in words.
 *
 * §3 makes the bead the tool's only *visual* status vocabulary, which is exactly
 * why the state also has to exist as text: the bead is `aria-hidden`, so this is
 * what reaches a screen reader (T17), and it is not a colour anyone has to decode.
 */
export function toolStatusLabel(status: ToolStepStatus): string {
  switch (status) {
    case 'awaiting-approval': return '等待授权'
    case 'running': return '执行中'
    case 'done': return '完成'
    case 'failed': return '失败'
  }
}

function toStep(item: TranscriptItem): ActivityStep {
  switch (item.kind) {
    case 'thinking':
      return {
        kind: 'thinking',
        id: item.id,
        text: item.text,
        ...(item.pending === true ? { pending: true } : {}),
        ...(item.summary === undefined ? {} : { summary: item.summary }),
      }
    case 'tool': {
      const tool = item.tool ?? { displayName: item.toolName ?? '', useSummary: '' }
      return {
        // `TodoWrite` is the one tool whose body lives elsewhere: the task panel
        // above the composer owns the list, so the step is a single line (§4.4).
        kind: item.toolName === TASK_TOOL ? 'task' : 'tool',
        id: item.id,
        text: item.text,
        status: toolStepStatus(item),
        tool,
        ...(item.toolName === undefined ? {} : { toolName: item.toolName }),
        ...(item.pending === true ? { pending: true } : {}),
        ...(item.failed === true ? { failed: true } : {}),
      }
    }
    case 'subagent':
      return {
        kind: 'subagent',
        id: item.id,
        text: item.text,
        ...(item.pending === true ? { pending: true } : {}),
      }
    // A notice or error inside a turn is a system record — a compaction, an
    // interruption — and where it happened is the information (§4.4).
    case 'notice':
      return { kind: 'system', id: item.id, text: item.text }
    case 'error':
      return { kind: 'system', id: item.id, text: item.text, failed: true }
    // Staged prose between tools: a step, shown whole, never folded (§4.4).
    default:
      return { kind: 'text', id: item.id, text: item.text }
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled session event: ${JSON.stringify(value)}`)
}
