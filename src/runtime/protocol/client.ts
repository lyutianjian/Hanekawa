import { randomUUID } from 'node:crypto'
import type { SessionRecord, TaskDisplaySnapshot } from '../../harness/types.js'
import type { PermissionMode } from '../../harness/permissions.js'
import type {
  AskUserQuestionRequest,
  AskUserQuestionResult,
} from '../../harness/types.js'
import type { ExitDialogInput, ExitPlanDecision } from '../../harness/planModeManager.js'
import type { CheckpointWithDiff } from '../../services/checkpoint/checkpointService.js'
import { createEmptySessionUsage, type SessionUsage } from '../sessionUsage.js'
import type { SessionControllerSnapshot, SessionEvent } from '../sessionController.js'
import type { RuntimeChannel } from './channel.js'
import { PendingRequests } from './pendingRequests.js'
import {
  type HostCommand,
  type HostEvent,
  type InterruptReason,
  type PermissionRequestDto,
  type UiResponse,
  type WireRunOverrides,
  type WireRuntimeSnapshot,
} from './wire.js'

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

  onEvent(listener: (event: SessionEvent) => void): () => void {
    this.eventListeners.add(listener)
    return () => {
      this.eventListeners.delete(listener)
    }
  }

  // --- commands ---------------------------------------------------------

  async hello(): Promise<{ sessionId: string }> {
    return this.send({ type: 'hello', id: randomUUID() }) as Promise<{ sessionId: string }>
  }

  async submit(input: string, overrides?: WireRunOverrides): Promise<void> {
    await this.send({ type: 'submit', id: randomUUID(), input, ...(overrides ? { overrides } : {}) })
  }

  async interrupt(reason: InterruptReason = 'user-cancel'): Promise<void> {
    await this.send({ type: 'interrupt', id: randomUUID(), reason })
  }

  async reload(): Promise<SessionRecord[]> {
    const result = await this.send({ type: 'reload', id: randomUUID() }) as { records: SessionRecord[] }
    return result.records
  }

  async retarget(sessionId: string): Promise<SessionRecord[]> {
    const result = await this.send({ type: 'retarget', id: randomUUID(), sessionId }) as { records: SessionRecord[] }
    return result.records
  }

  async runTool(name: string, input: unknown): Promise<{ ok: boolean; content: string; errorCode?: string }> {
    return this.send({ type: 'run-tool', id: randomUUID(), name, input }) as Promise<{
      ok: boolean
      content: string
      errorCode?: string
    }>
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

  async setModel(modelKey: string): Promise<{ modelKey: string; effort: string }> {
    return this.send({ type: 'set-model', id: randomUUID(), modelKey }) as Promise<{
      modelKey: string
      effort: string
    }>
  }

  async setEffort(level: string): Promise<string> {
    const result = await this.send({ type: 'set-effort', id: randomUUID(), level }) as { effort: string }
    return result.effort
  }

  async setPermissionMode(mode: PermissionMode): Promise<PermissionMode> {
    const result = await this.send({ type: 'set-permission-mode', id: randomUUID(), mode }) as { mode: PermissionMode }
    return result.mode
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const off of this.teardown.splice(0)) off()
    this.failAllPending('The client was disposed.')
    this.eventListeners.clear()
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

  private async answer(request: Extract<HostEvent, { type: 'ui-request' }>['request']): Promise<void> {
    const response = await this.resolveUiRequest(request)
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
