import { randomUUID } from 'node:crypto'
import type { SessionRecord, TaskDisplaySnapshot } from '../../harness/types.js'
import type { PermissionMode } from '../../harness/permissions.js'
import type {
  AskUserQuestionRequest,
  AskUserQuestionResult,
} from '../../harness/types.js'
import type { ExitDialogInput, ExitPlanDecision } from '../../harness/planModeManager.js'
import type { BackgroundTaskSnapshot } from '../../services/backgroundTasks/registry.js'
import type { CheckpointWithDiff } from '../../services/checkpoint/checkpointService.js'
import type { SessionMeta } from '../../sessions/service.js'
import type { FileSuggestion } from '../suggestions/atToken.js'
import { createEmptySessionUsage, type SessionUsage } from '../sessionUsage.js'
import type { RewindSummaryDecision } from '../rewindSummary.js'
import type { SessionControllerSnapshot, SessionEvent } from '../sessionController.js'
import type { RuntimeChannel } from './channel.js'
import { PendingRequests } from './pendingRequests.js'
import {
  UI_REQUEST_FALLBACKS,
  type CommandEffect,
  type HostCommand,
  type HostEvent,
  type InterruptReason,
  type PermissionRequestDto,
  type UiResponse,
  type WireBackgroundTasksResult,
  type WireClosePaneResult,
  type WireCommandInfo,
  type WireCommandsResult,
  type WireEffortResult,
  type WireFileSuggestionsResult,
  type WireHelloResult,
  type WireListPanesResult,
  type WireModelsResult,
  type WireOpenPaneResult,
  type WirePaneInfo,
  type WireReloadCountResult,
  type WireReloadSettingsResult,
  type WireResolveModelResult,
  type WireRewindResult,
  type WireRunCommandResult,
  type WireRunOverrides,
  type WireRuntimeSnapshot,
  type WireSessionSwitchResult,
  type WireSessionsResult,
  type WireTaskOutputResult,
  type WireTaskResult,
} from './wire.js'

const EMPTY_TASKS: readonly BackgroundTaskSnapshot[] = Object.freeze([])

/** Answers the four blocking questions a host can ask. */
export interface SessionClientHandlers {
  permission?: (request: PermissionRequestDto) => Promise<{ approved: boolean; alwaysAllow?: boolean }>
  askUserQuestion?: (request: AskUserQuestionRequest) => Promise<AskUserQuestionResult>
  enterPlan?: () => Promise<boolean>
  exitPlan?: (input: ExitDialogInput) => Promise<ExitPlanDecision>
}

/**
 * The UI half of the protocol.
 *
 * Mirrors the shape `SessionController` exposes — `onEvent` for the ordered
 * stream, `subscribe`/`getSnapshot` for pull state — so a view written against
 * one works against the other.
 *
 * The subtle part is snapshot identity. `SessionController.publish` compares
 * `usage` and `taskSnapshot` *by reference*, which works in-process because
 * they are only reassigned when they truly change. Deserialized messages have
 * no such luck: every `snapshot` that arrives is a fresh object graph, so
 * rebuilding state from each one would hand `useSyncExternalStore` a new
 * identity on every tick and re-render forever. This client field-diffs before
 * swapping, restoring the invariant the React contract needs.
 */
export class SessionClient {
  private readonly channel: RuntimeChannel
  private readonly replies = new PendingRequests<{ ok: true; result: unknown } | { ok: false; message: string }>()
  private readonly eventListeners = new Set<(event: SessionEvent) => void>()
  private readonly effectListeners = new Set<(effect: CommandEffect) => void>()
  private readonly paneListeners = new Set<(panes: readonly WirePaneInfo[]) => void>()
  private readonly listeners = new Set<() => void>()
  private handlers: SessionClientHandlers = {}

  private snapshot: SessionControllerSnapshot = Object.freeze({
    isStreaming: false,
    usage: createEmptySessionUsage(),
    taskSnapshot: undefined,
    spinnerSubText: undefined,
  })
  private subagentProgress: ReadonlyMap<string, string> = new Map()
  private runtimeSnapshot: WireRuntimeSnapshot | undefined
  private session: SessionMeta | undefined
  private backgroundTasks: readonly BackgroundTaskSnapshot[] = EMPTY_TASKS
  /** Pane list, kept identity-stable across `pane-list` events that re-announce the same set. */
  private panes: readonly WirePaneInfo[] = Object.freeze([])
  private readonly teardown: Array<() => void> = []
  private disposed = false

  constructor(channel: RuntimeChannel) {
    this.channel = channel
    this.teardown.push(channel.onMessage(this.handleMessage))
    this.teardown.push(channel.onClose(this.handleClose))
  }

  setHandlers(handlers: SessionClientHandlers): void {
    this.handlers = handlers
  }

  // --- pull state -------------------------------------------------------

  getSnapshot = (): SessionControllerSnapshot => this.snapshot

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getSubagentProgress(): ReadonlyMap<string, string> {
    return this.subagentProgress
  }

  getRuntimeSnapshot(): WireRuntimeSnapshot | undefined {
    return this.runtimeSnapshot
  }

  getBackgroundTasks = (): readonly BackgroundTaskSnapshot[] => this.backgroundTasks

  /**
   * The session the host is bound to, once it has said so.
   *
   * `undefined` until the first `session-changed` or `hello`; a shell that needs
   * it to paint should take it from `hello()`'s result instead of waiting.
   */
  getSession = (): SessionMeta | undefined => this.session

  onEvent(listener: (event: SessionEvent) => void): () => void {
    this.eventListeners.add(listener)
    return () => {
      this.eventListeners.delete(listener)
    }
  }

  /**
   * Renderer-side side effects pushed by a running slash command.
   *
   * Separate from `onEvent` because these are not session history: nothing here
   * is persisted, so a client that attaches later never sees the ones it missed —
   * exactly as the TUI behaves, where `writeLine` appends a display item rather
   * than a `SessionRecord`.
   */
  onCommandEffect(listener: (effect: CommandEffect) => void): () => void {
    this.effectListeners.add(listener)
    return () => {
      this.effectListeners.delete(listener)
    }
  }

  /**
   * The most recent pane topology the host has announced.
   *
   * Empty until the first `pane-list` event arrives; a shell that needs the
   * initial set to paint should call `listPanes()` instead of waiting.
   */
  getPanes = (): readonly WirePaneInfo[] => this.panes

  /**
   * Notified when the pane topology changes.
   *
   * The host pushes `pane-list` whenever a pane opens or closes; the client
   * field-diffs to keep the listener identity stable across re-announcements
   * of the same set.
   */
  onPanesChanged(listener: (panes: readonly WirePaneInfo[]) => void): () => void {
    this.paneListeners.add(listener)
    return () => {
      this.paneListeners.delete(listener)
    }
  }

  // --- commands ---------------------------------------------------------

  async hello(): Promise<WireHelloResult> {
    return this.send({ type: 'hello', id: randomUUID() }) as Promise<WireHelloResult>
  }

  async submit(input: string, overrides?: WireRunOverrides): Promise<void> {
    await this.send({ type: 'submit', id: randomUUID(), input, ...(overrides ? { overrides } : {}) })
  }

  async interrupt(reason: InterruptReason = 'user-cancel'): Promise<void> {
    await this.send({ type: 'interrupt', id: randomUUID(), reason })
  }

  /** Reloads *records*. The `reload*` methods below reload host state. */
  async reload(): Promise<SessionRecord[]> {
    const result = await this.send({ type: 'reload', id: randomUUID() }) as { records: SessionRecord[] }
    return result.records
  }

  async retarget(sessionId: string): Promise<WireSessionSwitchResult> {
    return this.send({ type: 'retarget', id: randomUUID(), sessionId }) as Promise<WireSessionSwitchResult>
  }

  async createSession(title?: string): Promise<WireSessionSwitchResult> {
    return this.send({
      type: 'create-session',
      id: randomUUID(),
      ...(title ? { title } : {}),
    }) as Promise<WireSessionSwitchResult>
  }

  async listSessions(): Promise<SessionMeta[]> {
    const result = await this.send({ type: 'list-sessions', id: randomUUID() }) as WireSessionsResult
    return result.sessions
  }

  async listModels(): Promise<WireModelsResult> {
    return this.send({ type: 'list-models', id: randomUUID() }) as Promise<WireModelsResult>
  }

  async resolveModel(input: string): Promise<string | undefined> {
    const result = await this.send({ type: 'resolve-model', id: randomUUID(), input }) as WireResolveModelResult
    return result.modelKey
  }

  async setDefaultModel(reference: string): Promise<WireModelsResult> {
    return this.send({
      type: 'set-default-model',
      id: randomUUID(),
      reference,
    }) as Promise<WireModelsResult>
  }

  async reloadAgents(): Promise<number> {
    const result = await this.send({ type: 'reload-agents', id: randomUUID() }) as WireReloadCountResult
    return result.count
  }

  async reloadSkills(): Promise<number> {
    const result = await this.send({ type: 'reload-skills', id: randomUUID() }) as WireReloadCountResult
    return result.count
  }

  async reloadSettings(): Promise<WireReloadSettingsResult> {
    return this.send({ type: 'reload-settings', id: randomUUID() }) as Promise<WireReloadSettingsResult>
  }

  async listBackgroundTasks(): Promise<BackgroundTaskSnapshot[]> {
    const result = await this.send({
      type: 'list-background-tasks',
      id: randomUUID(),
    }) as WireBackgroundTasksResult
    return result.tasks
  }

  async peekTaskOutput(taskId: string, maxBytes?: number): Promise<string> {
    const result = await this.send({
      type: 'peek-task-output',
      id: randomUUID(),
      taskId,
      ...(maxBytes === undefined ? {} : { maxBytes }),
    }) as WireTaskOutputResult
    return result.output
  }

  async killTask(taskId: string, reason?: string): Promise<BackgroundTaskSnapshot | undefined> {
    const result = await this.send({
      type: 'kill-task',
      id: randomUUID(),
      taskId,
      ...(reason ? { reason } : {}),
    }) as WireTaskResult
    return result.task
  }

  async runTool(name: string, input: unknown): Promise<{ ok: boolean; content: string; errorCode?: string }> {
    return this.send({ type: 'run-tool', id: randomUUID(), name, input }) as Promise<{
      ok: boolean
      content: string
      errorCode?: string
    }>
  }

  /**
   * Runs a slash command in the host.
   *
   * Anything the command wants drawn arrives beforehand on `onCommandEffect`,
   * not in this result — see `CommandEffect`. A rejected promise means the
   * command could not be *dispatched*; a command that failed on its own terms
   * resolves as handled and explains itself through a `write-line`.
   */
  async runCommand(input: string): Promise<WireRunCommandResult> {
    return this.send({ type: 'run-command', id: randomUUID(), input }) as Promise<WireRunCommandResult>
  }

  /**
   * Metadata for the registered slash commands, for a completion dropdown.
   *
   * Worth re-asking after `reloadSkills()`: skill commands come off disk and the
   * set changes without any event announcing it.
   */
  async listCommands(): Promise<WireCommandInfo[]> {
    const result = await this.send({ type: 'list-commands', id: randomUUID() }) as WireCommandsResult
    return result.commands
  }

  /**
   * `@` file candidates for the composer's current text and caret.
   *
   * Deliberately not cached and not debounced here: both are the caller's
   * decisions, and a caller that fires one of these per keystroke **must**
   * discard answers that arrive out of order — nothing about a `send()` promise
   * guarantees that the newest request settles last.
   */
  async fileSuggestions(input: string, cursorPos: number): Promise<FileSuggestion[]> {
    const result = await this.send({
      type: 'file-suggestions',
      id: randomUUID(),
      input,
      cursorPos,
    }) as WireFileSuggestionsResult
    return result.suggestions
  }

  async getCheckpoints(): Promise<CheckpointWithDiff[]> {
    const result = await this.send({ type: 'checkpoints', id: randomUUID() }) as { checkpoints: CheckpointWithDiff[] }
    return result.checkpoints
  }

  async restoreCode(commitHash: string): Promise<{ success: boolean; error?: string }> {
    return this.send({ type: 'restore-code', id: randomUUID(), commitHash }) as Promise<{
      success: boolean
      error?: string
    }>
  }

  /**
   * Drops everything from `messageId` onward. Rejects when the message is not
   * in the session, so a stale checkpoint list cannot silently no-op.
   *
   * `restore-code-and-conversation` is this plus `restoreCode()`; there is no
   * combined command.
   */
  async truncateSession(messageId: string): Promise<SessionRecord[]> {
    const result = await this.send({
      type: 'truncate-session',
      id: randomUUID(),
      messageId,
    }) as WireRewindResult
    return result.records
  }

  /**
   * Replaces one half of the conversation with a summary of it.
   *
   * Slow by nature: the summary is a real provider call queued behind whatever
   * the loop is already doing.
   */
  async summarizeRewind(messageId: string, decision: RewindSummaryDecision): Promise<SessionRecord[]> {
    const result = await this.send({
      type: 'summarize-rewind',
      id: randomUUID(),
      messageId,
      decision,
    }) as WireRewindResult
    return result.records
  }

  async setModel(modelKey: string): Promise<{ modelKey: string; effort: string }> {
    return this.send({ type: 'set-model', id: randomUUID(), modelKey }) as Promise<{
      modelKey: string
      effort: string
    }>
  }

  async setEffort(level: string, options: { persist?: boolean } = {}): Promise<WireEffortResult> {
    return this.send({
      type: 'set-effort',
      id: randomUUID(),
      level,
      ...(options.persist ? { persist: true } : {}),
    }) as Promise<WireEffortResult>
  }

  async setPermissionMode(mode: PermissionMode): Promise<PermissionMode> {
    const result = await this.send({ type: 'set-permission-mode', id: randomUUID(), mode }) as { mode: PermissionMode }
    return result.mode
  }

  /**
   * The one command that tolerates the transport dying mid-flight: the host
   * going away is the success case, and a shell must not refuse to close its
   * window because the reply never arrived.
   */
  async shutdown(reason: string): Promise<void> {
    try {
      await this.send({ type: 'shutdown', id: randomUUID(), reason })
    } catch {
      // Already gone.
    }
  }

  // --- pane (multi-tab) commands ----------------------------------------

  /**
   * Opens a new tab. Without `sessionId` the host mints a fresh draft; with
   * one, the host resolves the existing session (returning the pane that
   * already shows it, if any — one pane per session).
   *
   * The reply is the same shape `hello` returns: the caller learns the
   * session id, the records that should be on screen, and the startup notices
   * for the new tab.
   */
  async openPane(options: { sessionId?: string; title?: string } = {}): Promise<WireOpenPaneResult> {
    return this.send({
      type: 'open-pane',
      id: randomUUID(),
      ...(options.sessionId ? { sessionId: options.sessionId } : {}),
      ...(options.title ? { title: options.title } : {}),
    }) as Promise<WireOpenPaneResult>
  }

  /** Closes a tab by pane id. `paneId` is the same value `WirePaneInfo.paneId` carries. */
  async closePane(paneId: string): Promise<void> {
    await this.send({ type: 'close-pane', id: randomUUID(), paneId })
  }

  /** Lists every open tab. */
  async listPanes(): Promise<readonly WirePaneInfo[]> {
    const result = await this.send({ type: 'list-panes', id: randomUUID() }) as WireListPanesResult
    return result.panes
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const off of this.teardown.splice(0)) off()
    this.failAllPending('The client was disposed.')
    this.backgroundTasks = EMPTY_TASKS
    this.panes = Object.freeze([])
    this.eventListeners.clear()
    this.effectListeners.clear()
    this.paneListeners.clear()
    this.listeners.clear()
  }

  // --- plumbing ---------------------------------------------------------

  private async send(command: Exclude<HostCommand, { type: 'ui-response' }>): Promise<unknown> {
    if (this.disposed) throw new Error('The client was disposed.')
    const pending = this.replies.create(command.id)
    this.channel.post(command)
    const settled = await pending
    if (!settled.ok) throw new Error(settled.message)
    return settled.result
  }

  private handleMessage = (message: unknown): void => {
    const event = message as HostEvent
    if (!event || typeof event !== 'object' || typeof event.type !== 'string') return

    switch (event.type) {
      case 'session-event':
        for (const listener of [...this.eventListeners]) listener(event.event)
        return
      case 'snapshot':
        this.subagentProgress = new Map(event.subagentProgress)
        this.applySnapshot(event.snapshot)
        return
      case 'runtime-snapshot':
        this.runtimeSnapshot = event.snapshot
        this.notify()
        return
      case 'background-tasks':
        this.applyBackgroundTasks(event.tasks)
        return
      case 'session-changed':
        this.applySession(event.session)
        return
      case 'pane-list':
        this.applyPanes(event.panes)
        return
      case 'command-effect':
        for (const listener of [...this.effectListeners]) listener(event.effect)
        return
      case 'ui-request':
        void this.answer(event.request)
        return
      case 'reply':
        this.replies.settle(event.id, { ok: true, result: event.result })
        return
      case 'fail':
        this.replies.settle(event.id, { ok: false, message: event.message })
        return
    }
  }

  /**
   * Swaps the snapshot only when a field actually differs, so `getSnapshot()`
   * keeps returning the same object while nothing has changed.
   */
  private applySnapshot(next: SessionControllerSnapshot): void {
    const previous = this.snapshot
    const usage = sameUsage(previous.usage, next.usage) ? previous.usage : next.usage
    const taskSnapshot = sameTaskSnapshot(previous.taskSnapshot, next.taskSnapshot)
      ? previous.taskSnapshot
      : next.taskSnapshot

    if (
      previous.isStreaming === next.isStreaming
      && previous.spinnerSubText === next.spinnerSubText
      && usage === previous.usage
      && taskSnapshot === previous.taskSnapshot
    ) return

    this.snapshot = Object.freeze({
      isStreaming: next.isStreaming,
      usage,
      taskSnapshot,
      spinnerSubText: next.spinnerSubText,
    })
    this.notify()
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener()
  }

  /**
   * Same identity discipline as the snapshot, and for the same reason: the
   * host re-sends the whole list on every change, so a fresh array would hand
   * `useSyncExternalStore` a new identity on every output chunk.
   */
  private applyBackgroundTasks(next: BackgroundTaskSnapshot[]): void {
    if (sameTaskList(this.backgroundTasks, next)) return
    this.backgroundTasks = next
    this.notify()
  }

  /**
   * Field-diffed like the rest. `updatedAt` and `messageCount` move on every
   * turn, so the host re-announcing the same session — which it does on any
   * switch, including one that landed back where it started — must not wake
   * every subscriber.
   */
  private applySession(next: SessionMeta): void {
    const previous = this.session
    if (
      previous
      && previous.id === next.id
      && previous.title === next.title
      && previous.messageCount === next.messageCount
      && previous.updatedAt === next.updatedAt
    ) return
    this.session = next
    this.notify()
  }

  /**
   * Pane topology is field-diffed by id-set comparison: a re-announcement of
   * the same pane ids in the same order does not swap the array, so a tab bar
   * built on this signal does not re-render on every event the host pushes.
   *
   * The internal array is frozen, so a consumer that destructures it sees a
   * stable object across calls — and so does `onPanesChanged`, who receives
   * the same reference until the topology actually changes.
   */
  private applyPanes(next: readonly WirePaneInfo[]): void {
    if (samePaneList(this.panes, next)) return
    this.panes = Object.freeze([...next])
    this.notify()
    for (const listener of [...this.paneListeners]) listener(this.panes)
  }

  /**
   * Answers a host's blocking question, and *always* answers.
   *
   * The try/catch is load-bearing rather than defensive: `handleMessage` calls
   * this as `void this.answer(...)`, so a handler that throws would leave no
   * `ui-response` on the wire at all. Nothing else releases the host —
   * `PermissionGate.approve` has no timeout, and `ToolRunner.run` does not pass
   * its abort signal into it, so interrupting the turn will not free it either.
   * The agent loop would wait for the rest of the process's life.
   *
   * The fallback is the kind's own, so the asymmetry survives: deny a tool,
   * reject a question, but *approve* entering plan mode.
   */
  private async answer(request: Extract<HostEvent, { type: 'ui-request' }>['request']): Promise<void> {
    let response: UiResponse
    try {
      response = await this.resolveUiRequest(request)
    } catch {
      response = UI_REQUEST_FALLBACKS[request.kind]()
    }
    this.channel.post({ type: 'ui-response', requestId: request.requestId, response } satisfies HostCommand)
  }

  /**
   * With no handler installed the client answers the way the host would if it
   * had never been asked, so an unfinished UI degrades the same way a missing
   * one does rather than hanging the agent.
   */
  private async resolveUiRequest(
    request: Extract<HostEvent, { type: 'ui-request' }>['request'],
  ): Promise<UiResponse> {
    switch (request.kind) {
      case 'permission': {
        if (!this.handlers.permission) return { kind: 'permission', approved: false }
        const answer = await this.handlers.permission(request.payload)
        return { kind: 'permission', approved: answer.approved, ...(answer.alwaysAllow ? { alwaysAllow: true } : {}) }
      }
      case 'ask-user-question': {
        if (!this.handlers.askUserQuestion) {
          return {
            kind: 'ask-user-question',
            result: { kind: 'rejected', feedback: 'AskUserQuestion UI is not mounted.' },
          }
        }
        return { kind: 'ask-user-question', result: await this.handlers.askUserQuestion(request.payload) }
      }
      case 'enter-plan':
        return { kind: 'enter-plan', approved: this.handlers.enterPlan ? await this.handlers.enterPlan() : true }
      case 'exit-plan': {
        if (!this.handlers.exitPlan) return { kind: 'exit-plan', decision: { kind: 'reject', feedback: '' } }
        return { kind: 'exit-plan', decision: await this.handlers.exitPlan(request.payload) }
      }
    }
  }

  private handleClose = (): void => {
    this.failAllPending('The host disconnected.')
  }

  private failAllPending(message: string): void {
    this.replies.settleAll(() => ({ ok: false, message }))
  }
}

/**
 * Compared field by field rather than deeply: the fields that move are the
 * ones a task list renders, and `outputBytes`/`unreadBytes` change on every
 * chunk, which is exactly what the comparison needs to catch.
 */
function sameTaskList(
  a: readonly BackgroundTaskSnapshot[],
  b: readonly BackgroundTaskSnapshot[],
): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  return a.every((task, index) => {
    const other = b[index]
    if (!other) return false
    return task.id === other.id
      && task.status === other.status
      && task.outputBytes === other.outputBytes
      && task.unreadBytes === other.unreadBytes
      && task.finishedAt === other.finishedAt
  })
}

function sameUsage(a: SessionUsage, b: SessionUsage): boolean {
  return sameTokens(a.total, b.total) && sameTokens(a.lastRequest, b.lastRequest)
}

function sameTokens(
  a: { inputTokens: number; cacheReadInputTokens: number; outputTokens: number } | null,
  b: { inputTokens: number; cacheReadInputTokens: number; outputTokens: number } | null,
): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return a.inputTokens === b.inputTokens
    && a.cacheReadInputTokens === b.cacheReadInputTokens
    && a.outputTokens === b.outputTokens
}

/**
 * Compared structurally rather than deeply: the snapshot is regenerated on the
 * host whenever a task changes, so a cheap shape+status check is enough to
 * decide whether the UI has anything new to show.
 */
function sameTaskSnapshot(a: TaskDisplaySnapshot | undefined, b: TaskDisplaySnapshot | undefined): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * Two pane lists are the same when every pane id matches in the same order and
 * every title still matches. A re-announcement of the same topology — which the
 * host does on every open / close — must not wake the tab bar.
 */
function samePaneList(a: readonly WirePaneInfo[], b: readonly WirePaneInfo[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let index = 0; index < a.length; index += 1) {
    const left = a[index]!
    const right = b[index]!
    if (left.paneId !== right.paneId) return false
    if (left.sessionId !== right.sessionId) return false
    if (left.sessionTitle !== right.sessionTitle) return false
  }
  return true
}
