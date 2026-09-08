import { randomUUID } from 'node:crypto'
import type { AgentRunOverrides, ActiveModelRuntime } from '../harness/loop.js'
import { logDiagnostics, summarizeDiagnosticsForTui } from '../harness/diagnostics.js'
import type {
  AgentRunResult,
  ModelStreamEvent,
  SessionRecord,
  TaskDisplaySnapshot,
  TokenUsage,
  ToolProgressEvent,
} from '../harness/types.js'
import { deriveSessionTitle, type SessionMeta, type SessionStore } from '../sessions/service.js'
import { FileHistoryService } from '../services/fileHistory/fileHistoryService.js'
import type { ImageAttachmentRef, UserInput } from '../media/types.js'
import type { RecordProxy } from './bridges.js'
import { rollbackInterruptedPromptIfSynthetic } from './interruptRollback.js'
import {
  addTokenUsage,
  createEmptySessionUsage,
  findLatestTaskSnapshot,
  formatInterruptMessage,
  type SessionUsage,
} from './sessionUsage.js'
import {
  formatSingleToolProgress,
  formatSubagentSpinnerProgress,
  formatToolProgress,
} from './toolProgress.js'
import type { AgentSession } from './types.js'

/**
 * Everything a UI must react to during a session, as one ordered stream.
 *
 * The stream is deliberately a single union rather than named EventEmitter
 * channels: it is the exact payload a desktop shell will forward over IPC, and
 * a union lets TypeScript check the consumer's dispatch exhaustively.
 *
 * Presentation state that has no meaning outside a terminal (transcript
 * static/live partitioning, `<Static>` remount keys, spinner phase) is *not*
 * modelled here — the adapter derives it from these events.
 */
export type SessionEvent =
  /** A turn is beginning. Emitted synchronously before any I/O. */
  | { type: 'turn-start'; messageId: string; displayInput: string; createdAt: string; images?: ImageAttachmentRef[] }
  /** A record reached the UI. `approvalToolUseId`/`subagentProgress` are the correlations the controller tracks. */
  | { type: 'record'; record: SessionRecord; approvalToolUseId?: string; subagentProgress?: string }
  /** The set of in-flight tool calls changed. Spinner text itself lives on the snapshot. */
  | { type: 'tool-progress'; listContent?: string }
  /** Raw model stream event, forwarded untouched. */
  | { type: 'stream'; event: ModelStreamEvent }
  /** A one-off message to surface in the transcript. */
  | { type: 'notice'; level: 'system' | 'error'; content: string }
  /**
   * The session's own metadata moved without the session moving — today, the
   * title it takes from its first message.
   *
   * Separate from `record` because the consumers are different: a shell draws
   * this in its window chrome (a tab, a sidebar row, a header), not in the
   * transcript. The id never changes here; a shell that reacts by *switching*
   * sessions has misread it.
   */
  | { type: 'session-meta'; session: SessionMeta }
  /** The session's records were replaced wholesale; rebuild from `records`. */
  | { type: 'transcript-reset'; records: readonly SessionRecord[]; systemMessages: readonly string[]; bumpGeneration: boolean }
  /** An interrupted prompt was rolled back; put the input back in the composer. */
  | { type: 'restore-input'; text: string; images?: ImageAttachmentRef[] }
  /** The loop switched models on its own (fallback activation). */
  | { type: 'active-model'; model: Omit<ActiveModelRuntime, 'provider'> }
  /**
   * The turn finished. `aborted` mirrors `AbortSignal.aborted`, *not* "did it
   * throw" — a failed turn is not aborted and still gets a duration summary.
   */
  | { type: 'turn-end'; aborted: boolean; rolledBack: boolean; durationMs: number; usage?: TokenUsage }

/** The pull-based half of the controller, shaped for `useSyncExternalStore`. */
export interface SessionControllerSnapshot {
  readonly isStreaming: boolean
  readonly usage: SessionUsage
  readonly taskSnapshot: TaskDisplaySnapshot | undefined
  readonly spinnerSubText: string | undefined
}

export interface SessionControllerDeps {
  cwd: string
  store: SessionStore
  session: SessionMeta
  existingRecords: readonly SessionRecord[]
  /** The controller owns all three of this proxy's handlers; nothing else may install them. */
  recordProxy: RecordProxy
  /** Read once per turn, so a mid-turn runtime swap cannot retarget the in-flight run. */
  getSession: () => AgentSession
  /** Seam for tests; production backs up real files under `~/.myagent`. */
  createFileHistoryService?: (cwd: string, sessionId: string) => FileHistoryService
}

/**
 * The headless half of a chat session: turn lifecycle, token accounting,
 * file history, tool-progress correlation and interrupt rollback.
 *
 * Owns no framework state. The TUI subscribes to {@link onEvent} for the
 * ordered stream and to {@link subscribe}/{@link getSnapshot} for the pull
 * state; an Electron main process can forward both across IPC unchanged.
 */
export class SessionController {
  private readonly cwd: string
  private readonly store: SessionStore
  private readonly recordProxy: RecordProxy
  private readonly getSession: () => AgentSession
  private readonly newFileHistoryService: (cwd: string, sessionId: string) => FileHistoryService

  private session: SessionMeta
  private abortController: AbortController | null = null
  /** Most recent tool_use id per tool name, for matching the approval record that follows. */
  private readonly lastToolUseIdByTool = new Map<string, string>()
  private readonly activeToolProgress = new Map<string, ToolProgressEvent>()
  private readonly subagentProgress = new Map<string, string>()
  private fileHistory: FileHistoryService
  /**
   * False until `init()` has replayed the log. Snapshots taken before that
   * would be wiped by the replay, and an edit tracked before the turn's
   * snapshot exists has nothing to attach itself to.
   */
  private fileHistoryReady = false
  private didRollback = false
  private loopStartMs = 0

  private streaming = false
  private usage: SessionUsage = createEmptySessionUsage()
  private taskSnapshot: TaskDisplaySnapshot | undefined
  private spinnerSubText: string | undefined

  private snapshot: SessionControllerSnapshot
  private readonly listeners = new Set<() => void>()
  private readonly eventListeners = new Set<(event: SessionEvent) => void>()
  private disposed = false

  constructor(deps: SessionControllerDeps) {
    this.cwd = deps.cwd
    this.store = deps.store
    this.recordProxy = deps.recordProxy
    this.getSession = deps.getSession
    this.newFileHistoryService = deps.createFileHistoryService
      ?? ((cwd, sessionId) => new FileHistoryService(cwd, sessionId))
    this.session = deps.session
    this.taskSnapshot = findLatestTaskSnapshot(deps.existingRecords)
    this.snapshot = this.buildSnapshot()

    this.fileHistory = this.newFileHistoryService(this.cwd, this.session.id)
    this.initFileHistory(this.fileHistory)

    this.recordProxy.setHandler(this.handleRecord)
    this.recordProxy.setProgressHandler(this.handleProgress)
    this.recordProxy.setStreamEventHandler(this.handleStreamEvent)
  }

  // --- pull state -----------------------------------------------------------

  getSnapshot = (): SessionControllerSnapshot => this.snapshot

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * Live per-agent progress text. Deliberately *not* on the snapshot: consumers
   * need the whole map by reference and it changes on every tool event.
   */
  getSubagentProgress(): ReadonlyMap<string, string> {
    return this.subagentProgress
  }

  // --- event stream ---------------------------------------------------------

  onEvent(listener: (event: SessionEvent) => void): () => void {
    this.eventListeners.add(listener)
    return () => {
      this.eventListeners.delete(listener)
    }
  }

  // --- commands -------------------------------------------------------------

  /**
   * Runs one turn. Resolves when the turn is over, however it ended.
   *
   * The input is a {@link UserInput} — text always, image refs when the turn
   * has any — so the submission path has a single shape from either shell down
   * to the loop. Callers that only have text wrap it as `{ text }`; there is no
   * parallel string channel on this method.
   *
   * Rejects rather than queueing when a turn is already in flight: everything
   * below assigns to `this.abortController`, so a second concurrent run would
   * overwrite the live one and leave the first turn impossible to interrupt.
   * Deciding *what* to do with the rejected input is a shell's job — the two
   * shells answer differently (both enqueue it, but "the UI is blocked" means
   * different things; see `queuePump.ts`) — and both callers catch it.
   *
   * It throws rather than silently returning because a dropped message is
   * indistinguishable from a message that was sent and answered with nothing.
   */
  async submit(input: UserInput, options?: AgentRunOverrides): Promise<void> {
    if (this.streaming) {
      throw new Error('A turn is already running; queue the message instead of submitting it.')
    }
    const agentSession = this.getSession()
    const loop = agentSession.loop
    const messageId = randomUUID()

    this.emit({
      type: 'turn-start',
      messageId,
      displayInput: options?.displayInput ?? input.text,
      createdAt: new Date().toISOString(),
      ...(input.images && input.images.length > 0 ? { images: input.images } : {}),
    })

    this.streaming = true
    this.spinnerSubText = undefined

    const ac = new AbortController()
    let completedResult: AgentRunResult | undefined

    // The `try` starts here rather than after the checkpoint so that *every*
    // statement past `streaming = true` is covered by the `finally` that clears
    // it. `publish()` calls its subscribers synchronously and one of them is a
    // channel post, so a dead renderer used to be able to throw out of this
    // method with the flag still set — which merely wedged the spinner before
    // the guard above existed, and would now reject every later turn as well.
    // Ordering inside is unchanged: publish, then snapshot, then run.
    try {
      this.publish()

      await this.snapshotFileHistory(messageId)

      this.abortController = ac
      this.didRollback = false
      this.loopStartMs = Date.now()

      const result = await loop.run(input, ac.signal, messageId, options)
      completedResult = result
      this.usage = {
        lastRequest: result.statusUsage ?? null,
        total: addTokenUsage(this.usage.total, result.usage),
      }
      this.publish()
    } catch (err: unknown) {
      if (err instanceof Error && (err.name === 'AbortError' || (err as Error & { aborted?: boolean }).aborted)) {
        const restored = await this.tryRestoreInterruptedPrompt(ac.signal, messageId, input)
        if (restored) {
          this.didRollback = true
        } else {
          this.emit({
            type: 'notice',
            level: 'system',
            content: await formatInterruptMessage(this.store, this.session.id, messageId),
          })
        }
      } else {
        this.emit({
          type: 'notice',
          level: 'error',
          content: err instanceof Error ? err.message : String(err),
        })
      }
    } finally {
      this.emit({ type: 'active-model', model: loop.getActiveModel() })

      this.abortController = null
      this.lastToolUseIdByTool.clear()
      this.activeToolProgress.clear()
      this.subagentProgress.clear()
      this.streaming = false
      this.spinnerSubText = undefined
      this.publish()

      this.emit({
        type: 'turn-end',
        aborted: ac.signal.aborted,
        rolledBack: this.didRollback,
        durationMs: Date.now() - this.loopStartMs,
        ...(completedResult ? { usage: completedResult.usage } : {}),
      })
    }
  }

  interrupt(reason: unknown = 'user-cancel'): void {
    this.abortController?.abort(reason)
  }

  /** Reloads records from disk (after truncation or a rewind) and rebuilds the view. */
  async reload(): Promise<SessionRecord[]> {
    const loaded = await this.store.loadRecordsWithDiagnostics(this.session.id)
    logDiagnostics(loaded.diagnostics)
    const summary = summarizeDiagnosticsForTui(loaded.diagnostics)
    this.taskSnapshot = findLatestTaskSnapshot(loaded.records)
    this.publish()
    this.emit({
      type: 'transcript-reset',
      records: loaded.records,
      systemMessages: summary ? [summary] : [],
      bumpGeneration: true,
    })
    return loaded.records
  }

  /**
   * Points the controller at a different session (`/clear`, `/resume`).
   * Resets everything that is scoped to a session, including token totals.
   */
  retarget(session: SessionMeta, records: readonly SessionRecord[]): void {
    this.session = session
    this.lastToolUseIdByTool.clear()
    this.activeToolProgress.clear()
    this.subagentProgress.clear()
    this.usage = createEmptySessionUsage()
    this.taskSnapshot = findLatestTaskSnapshot(records)
    this.spinnerSubText = undefined
    this.fileHistoryReady = false
    // The outgoing service may still have backups in flight.
    this.fileHistory.dispose()
    this.fileHistory = this.newFileHistoryService(this.cwd, session.id)
    this.initFileHistory(this.fileHistory)
    this.publish()
  }

  /**
   * Refreshes the session meta *in place* — the session did not move, only its
   * metadata did (a rename).
   *
   * `retarget` is the wrong tool for that: it is the session-switch path and
   * clears usage, tool progress and the file history. The id guard is the
   * invariant that keeps the distinction real — this must never become a back
   * door around `sessionSwitch.ts`.
   */
  refreshSessionMeta(session: SessionMeta): void {
    if (session.id !== this.session.id) {
      throw new Error('refreshSessionMeta cannot change the session id; use retarget')
    }
    this.session = session
    this.publish()
  }

  /** The one file history for the active session; also drives `/rewind`. */
  getFileHistoryService(): FileHistoryService {
    return this.fileHistory
  }

  /**
   * Backs a file up before a write tool changes it. Handed to the scope's tool
   * context, so it must follow `retarget` to whichever session is live now —
   * hence the method rather than a bound reference to the service.
   */
  trackFileEdit = async (filePath: string): Promise<void> => {
    if (!this.fileHistoryReady) return
    try {
      await this.fileHistory.trackEdit(filePath)
    } catch (err) {
      // The edit itself matters more than being able to undo it.
      debugFileHistory(`Failed to track ${filePath}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  getSessionId(): string {
    return this.session.id
  }

  /**
   * The session this controller currently drives, which `retarget` moves.
   *
   * Named for the meta rather than "session" because the dep of that name is
   * the *runtime*. Exposed so nothing downstream has to keep a second copy in
   * sync: a `SessionPane` derives its session from here rather than tracking
   * one that a `/clear` in between would leave stale.
   */
  getSessionMeta(): SessionMeta {
    return this.session
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.fileHistoryReady = false
    // Stops any further backup or log write from a session that is going away.
    this.fileHistory.dispose()
    this.recordProxy.setHandler(() => {})
    this.recordProxy.setProgressHandler(() => {})
    this.recordProxy.setStreamEventHandler(() => {})
    this.listeners.clear()
    this.eventListeners.clear()
  }

  // --- proxy handlers -------------------------------------------------------

  private handleRecord = (record: SessionRecord): void => {
    let approvalToolUseId: string | undefined
    let subagentProgress: string | undefined

    this.noteDerivedTitle(record)

    if (record.type === 'tool_use') {
      this.lastToolUseIdByTool.set(record.tool, record.id)
    } else if (record.type === 'tool_approval') {
      approvalToolUseId = this.lastToolUseIdByTool.get(record.tool)
    } else if (record.type === 'tool_result') {
      if (record.display?.taskSnapshot) {
        this.taskSnapshot = record.display.taskSnapshot
        if (this.activeToolProgress.size === 0) this.spinnerSubText = undefined
        this.publish()
      }
    } else if (record.type === 'subagent_task') {
      subagentProgress = this.subagentProgress.get(record.agentId)
    }

    this.emit({
      type: 'record',
      record,
      ...(approvalToolUseId !== undefined ? { approvalToolUseId } : {}),
      ...(subagentProgress !== undefined ? { subagentProgress } : {}),
    })
  }

  private handleProgress = (event: ToolProgressEvent): void => {
    if (event.phase === 'started') {
      this.activeToolProgress.set(event.call.id, event)
      if (event.source?.type === 'subagent' && event.source.agentId) {
        this.subagentProgress.set(event.source.agentId, formatSingleToolProgress(event))
      }
    } else {
      this.activeToolProgress.delete(event.call.id)
      if (event.source?.type === 'subagent' && event.source.agentId) {
        this.subagentProgress.delete(event.source.agentId)
      }
    }

    const activeEvents = [...this.activeToolProgress.values()]
    const foregroundEvents = activeEvents.filter((candidate) => candidate.source?.type !== 'subagent')
    const backgroundEvents = activeEvents.filter((candidate) => candidate.source?.type === 'subagent')
    const content = foregroundEvents.length > 0
      ? formatToolProgress(foregroundEvents)
      : formatSubagentSpinnerProgress(backgroundEvents)

    this.spinnerSubText = content
    this.publish()
    this.emit({
      type: 'tool-progress',
      ...(foregroundEvents.length > 1 && content !== undefined ? { listContent: content } : {}),
    })
  }

  private handleStreamEvent = (event: ModelStreamEvent): void => {
    this.emit({ type: 'stream', event })
  }

  /**
   * Picks up the title the store just derived, for a session that had none.
   *
   * The store names a session from its first user message, inside
   * `appendRecord` — but nothing used to tell the *pane* about it. A pane's
   * session meta is the source every window projection reads
   * (`ProjectDirectory.describe` → `WireLaneInfo.sessionTitle`), so the canvas
   * header showed 「未命名会话」 for the whole first turn and the sidebar only
   * caught up when something else re-listed the store from disk.
   *
   * Derived rather than re-read: `AgentLoop.appendRecord` awaits the append
   * before it announces the record, so the index already holds this exact
   * string — `deriveSessionTitle` is the store's own rule — and a disk read here
   * would buy a race and a round trip for a value we have.
   */
  private noteDerivedTitle(record: SessionRecord): void {
    if (this.session.title !== undefined) return
    const title = deriveSessionTitle(record)
    if (title === undefined) return
    this.session = { ...this.session, title }
    this.publish()
    this.emit({ type: 'session-meta', session: this.session })
  }

  // --- internals ------------------------------------------------------------

  /**
   * A user-cancelled turn that produced nothing but synthetic interruption
   * records is rolled back entirely, so the prompt returns to the composer.
   *
   * The restore carries the input's images with its text, in their original
   * order: the rollback removed the user message that held them, and a
   * text-only restore would silently drop attachments the user still means to
   * send. The receiving shell owns what a restored draft looks like; this
   * method only guarantees the refs survive the round trip.
   */
  private async tryRestoreInterruptedPrompt(
    signal: AbortSignal,
    userMessageId: string,
    input: UserInput,
  ): Promise<boolean> {
    if (signal.reason !== 'user-cancel') return false

    try {
      const records = await rollbackInterruptedPromptIfSynthetic({
        store: this.store,
        sessionId: this.session.id,
        userMessageId,
      })
      if (!records) return false

      this.getSession().loop.invalidateRecordsCache()
      this.taskSnapshot = findLatestTaskSnapshot(records)
      this.publish()
      // Rebuilt from scratch, but without bumping the generation: this is a
      // rollback of the current turn, not a new conversation view.
      this.emit({ type: 'transcript-reset', records, systemMessages: [], bumpGeneration: false })
      this.emit({
        type: 'restore-input',
        text: input.text,
        ...(input.images && input.images.length > 0 ? { images: input.images } : {}),
      })
      return true
    } catch {
      return false
    }
  }

  /**
   * Opens the turn's snapshot. Every tracked file is carried forward at its
   * current version, so the edits this turn is about to make have something to
   * be undone back to.
   *
   * There is no "checkpoints are off for this session" state to report any
   * more: the cost is proportional to what the agent edited, not to the size of
   * the worktree, so no root is too large to snapshot.
   */
  private async snapshotFileHistory(messageId: string): Promise<void> {
    if (!this.fileHistoryReady) return
    try {
      await this.fileHistory.makeSnapshot(messageId)
    } catch (err) {
      // Graceful degradation: log and run the turn without a snapshot.
      debugFileHistory(`Error creating snapshot: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  private initFileHistory(service: FileHistoryService): void {
    void service.init().then(() => {
      // A later retarget may have already replaced it; only the live one counts.
      if (this.fileHistory === service && !this.disposed) this.fileHistoryReady = true
    }).catch((err) => {
      if (this.fileHistory === service) this.fileHistoryReady = false
      debugFileHistory(`Failed to initialize FileHistoryService: ${err instanceof Error ? err.message : String(err)}`)
    })
  }

  private buildSnapshot(): SessionControllerSnapshot {
    return Object.freeze({
      isStreaming: this.streaming,
      usage: this.usage,
      taskSnapshot: this.taskSnapshot,
      spinnerSubText: this.spinnerSubText,
    })
  }

  /** Swaps in a new snapshot and notifies, but only when something actually changed. */
  private publish(): void {
    const next = this.buildSnapshot()
    const previous = this.snapshot
    if (
      next.isStreaming === previous.isStreaming
      && next.usage === previous.usage
      && next.taskSnapshot === previous.taskSnapshot
      && next.spinnerSubText === previous.spinnerSubText
    ) return

    this.snapshot = next
    for (const listener of [...this.listeners]) listener()
  }

  private emit(event: SessionEvent): void {
    for (const listener of [...this.eventListeners]) listener(event)
  }
}

function debugFileHistory(message: string): void {
  if (process.env.MYAGENT_DEBUG_PROVIDER === '1') {
    console.error(`[hanekawa][file-history] ${message}`)
  }
}
