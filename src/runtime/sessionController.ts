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
import type { SessionMeta, SessionStore } from '../sessions/service.js'
import { CheckpointService } from '../services/checkpoint/checkpointService.js'
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
  | { type: 'turn-start'; messageId: string; displayInput: string; createdAt: string }
  /** A record reached the UI. `approvalToolUseId`/`subagentProgress` are the correlations the controller tracks. */
  | { type: 'record'; record: SessionRecord; approvalToolUseId?: string; subagentProgress?: string }
  /** The set of in-flight tool calls changed. Spinner text itself lives on the snapshot. */
  | { type: 'tool-progress'; listContent?: string }
  /** Raw model stream event, forwarded untouched. */
  | { type: 'stream'; event: ModelStreamEvent }
  /** A one-off message to surface in the transcript. */
  | { type: 'notice'; level: 'system' | 'error'; content: string }
  /** The session's records were replaced wholesale; rebuild from `records`. */
  | { type: 'transcript-reset'; records: readonly SessionRecord[]; systemMessages: readonly string[]; bumpGeneration: boolean }
  /** An interrupted prompt was rolled back; put the text back in the composer. */
  | { type: 'restore-input'; text: string }
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
  /** Seam for tests; production uses the real shadow-git service. */
  createCheckpointService?: (cwd: string, sessionId: string) => CheckpointService
}

/**
 * The headless half of a chat session: turn lifecycle, token accounting,
 * checkpointing, tool-progress correlation and interrupt rollback.
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
  private readonly newCheckpointService: (cwd: string, sessionId: string) => CheckpointService

  private session: SessionMeta
  private abortController: AbortController | null = null
  /** Most recent tool_use id per tool name, for matching the approval record that follows. */
  private readonly lastToolUseIdByTool = new Map<string, string>()
  private readonly activeToolProgress = new Map<string, ToolProgressEvent>()
  private readonly subagentProgress = new Map<string, string>()
  private checkpointService: CheckpointService
  private checkpointReady = false
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
    this.newCheckpointService = deps.createCheckpointService
      ?? ((cwd, sessionId) => new CheckpointService(cwd, sessionId))
    this.session = deps.session
    this.taskSnapshot = findLatestTaskSnapshot(deps.existingRecords)
    this.snapshot = this.buildSnapshot()

    this.checkpointService = this.newCheckpointService(this.cwd, this.session.id)
    this.initCheckpoints(this.checkpointService)

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

  /** Runs one turn. Resolves when the turn is over, however it ended. */
  async submit(input: string, options?: AgentRunOverrides): Promise<void> {
    const agentSession = this.getSession()
    const loop = agentSession.loop
    const messageId = randomUUID()

    this.emit({
      type: 'turn-start',
      messageId,
      displayInput: options?.displayInput ?? input,
      createdAt: new Date().toISOString(),
    })

    this.streaming = true
    this.spinnerSubText = undefined
    this.publish()

    await this.createCheckpoint(messageId)

    const ac = new AbortController()
    this.abortController = ac
    this.didRollback = false
    this.loopStartMs = Date.now()
    let completedResult: AgentRunResult | undefined

    try {
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
    this.checkpointReady = false
    this.checkpointService = this.newCheckpointService(this.cwd, session.id)
    this.initCheckpoints(this.checkpointService)
    this.publish()
  }

  /** The one checkpoint service for the active session; also drives `/rewind`. */
  getCheckpointService(): CheckpointService {
    return this.checkpointService
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

  // --- internals ------------------------------------------------------------

  /**
   * A user-cancelled turn that produced nothing but synthetic interruption
   * records is rolled back entirely, so the prompt returns to the composer.
   */
  private async tryRestoreInterruptedPrompt(
    signal: AbortSignal,
    userMessageId: string,
    input: string,
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
      this.emit({ type: 'restore-input', text: input })
      return true
    } catch {
      return false
    }
  }

  private async createCheckpoint(messageId: string): Promise<void> {
    if (!this.checkpointReady) return
    try {
      const result = await this.checkpointService.createCheckpoint(messageId)
      if (result.success && result.commitHash) {
        await this.store.addCheckpointMapping(this.session.id, messageId, result.commitHash)
      } else if (result.error) {
        debugCheckpoint(`Checkpoint creation failed: ${result.error}`)
      }
    } catch (err) {
      // Graceful degradation: log and continue without a checkpoint.
      debugCheckpoint(`Error creating checkpoint: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  private initCheckpoints(service: CheckpointService): void {
    void service.init().then(() => {
      // A later retarget may have already replaced it; only the live one counts.
      if (this.checkpointService === service) this.checkpointReady = true
    }).catch((err) => {
      if (this.checkpointService === service) this.checkpointReady = false
      debugCheckpoint(`Failed to initialize CheckpointService: ${err instanceof Error ? err.message : String(err)}`)
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

function debugCheckpoint(message: string): void {
  if (process.env.MYAGENT_DEBUG_PROVIDER === '1') {
    console.error(`[hanekawa][checkpoint] ${message}`)
  }
}
