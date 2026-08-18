import { randomUUID } from 'node:crypto'
import type { CommandContext, CommandDefinition } from '../../commands/types.js'
import { VALID_EFFORT_LEVELS, type EffortLevel } from '../../config/effort.js'
import { saveEffortLevel } from '../../config/settings.js'
import type { PermissionRequest } from '../../harness/permissions.js'
import type { RuntimeDiagnostic } from '../../harness/diagnostics.js'
import type { SessionRecord } from '../../harness/types.js'
import { resolveUsageWithCost } from '../../harness/usage.js'
import type { SessionMeta } from '../../sessions/service.js'
import { MessageQueue } from '../messageQueue.js'
import { applyPermissionModeTransition } from '../permissionMode.js'
import { buildModelPickerOptions } from '../modelPicker.js'
import { resolveRuntimeModelKeyAfterConfigChange } from '../providerRuntime.js'
import { canPumpQueue } from '../queuePump.js'
import { SessionRecordLedger } from '../recordLedger.js'
import { buildRewindSummaryRewrite } from '../rewindSummary.js'
import { generateFileSuggestions } from '../suggestions/fileSuggestions.js'
import type { RuntimeSlot } from '../runtimeSlot.js'
import type { SessionController, SessionEvent } from '../sessionController.js'
import {
  switchToExistingSession,
  switchToNewSession,
  type SessionSwitchDeps,
  type SessionSwitchResult,
} from '../sessionSwitch.js'
import { buildStartupNotices, resolveInitialQueuedPrompt, type StartupNotice } from '../startupNotices.js'
import type { ProjectRuntime, SessionScope } from '../types.js'
import type { SessionPane } from '../sessionWorkspace.js'
import type { RuntimeChannel } from './channel.js'
import { createHostCommandContext } from './commandContext.js'
import { parseHostCommand, type HostCommandParseFailure } from './commandSchema.js'
import { PendingRequests } from './pendingRequests.js'
import { toPermissionDto } from './permissionDto.js'
import {
  UI_REQUEST_FALLBACKS,
  type CommandEffect,
  type HostCommand,
  type HostEvent,
  type UiRequest,
  type UiResponse,
  type WireBackgroundTasksResult,
  type WireCommandInfo,
  type WireCommandsResult,
  type WireClosePaneResult,
  type WireEffortResult,
  type WireEnqueueResult,
  type WireFileSuggestionsResult,
  type WireHelloResult,
  type WireListPanesResult,
  type WireModelInfo,
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
  type WireUsageCost,
} from './wire.js'

function isEffortLevel(value: string): value is EffortLevel {
  return (VALID_EFFORT_LEVELS as readonly string[]).includes(value)
}

function assertNever(value: never): never {
  throw new Error(`Unhandled host command: ${JSON.stringify(value)}`)
}

/**
 * Four fields, copied one at a time. A spread would put `run` and `isEnabled` on
 * the wire; see `WireCommandInfo`.
 */
function toWireCommandInfo(command: CommandDefinition): WireCommandInfo {
  const info: WireCommandInfo = { name: command.name, description: command.description }
  if (command.aliases !== undefined) info.aliases = [...command.aliases]
  if (command.argumentHint !== undefined) info.argumentHint = command.argumentHint
  return info
}

export interface SessionHostDeps {
  channel: RuntimeChannel
  controller: SessionController
  runtimeSlot: RuntimeSlot
  /**
   * Split rather than one `RuntimeHost` because `SessionHost` is the only
   * consumer that ever gets a second instance. Keeping the halves apart here is
   * what stops session-scoped state being reached for on the project — and
   * project state being duplicated per tab.
   */
  project: ProjectRuntime
  scope: SessionScope
  /**
   * The registry of open panes.
   *
   * A pane is identified by the session it is bound to (one pane per session),
   * so `close-pane` / `list-panes` use the session id as the pane id. The host
   * is the only consumer that ever needs to reach for the workspace, and the
   * surface it relies on is documented by the `PaneRegistry` interface below.
   */
  workspace: PaneRegistry
  /**
   * Called when an `open-pane` command resolves to a fresh `SessionPane` that
   * needs a window, channel and host wired up by the shell.
   *
   * Hosts do not create `BrowserWindow`s themselves — they have no handle on
   * the Electron module — so the shell owns that step. The host still
   * resolves the pane (so the wire reply is the same shape regardless of pane
   * owner) and registers it in the workspace, then hands the constructed
   * pane off to the callback for window creation.
   */
  onPaneOpened: (pane: SessionPane, sessionId: string | undefined) => void
  /**
   * Called when a `close-pane` resolves to a real teardown. The shell detaches
   * the window, but the host is the one that ran `pane.close()` (which is
   * fixed-order: `interrupt('exit')` → controller → slot → scope), so the host
   * drives the command and the shell catches the side effect.
   */
  onPaneClosed: (paneId: string) => void
}

/**
 * The slice of `SessionWorkspace` the host reaches for.
 *
 * Declared structurally here so this file does not have to know that the
 * registry is a class; it also documents, by type, exactly which surface area
 * the host relies on.
 */
export interface PaneRegistry {
  list(): readonly SessionPane[]
  paneForSession(sessionId: string): SessionPane | undefined
  open(session: SessionMeta): Promise<SessionPane>
  adopt(scope: SessionScope, options: { modelKey?: string }): SessionPane
  close(pane: SessionPane): void
}

/**
 * The host half of the protocol: everything that must stay in the process that
 * owns the filesystem, the provider and the tools.
 *
 * It forwards the controller's event stream and both snapshots outward, turns
 * the four blocking UI bridges into request/response round trips, and executes
 * commands coming back. A client is a renderer; it never sees a `Tool`, a
 * `ModelProvider`, an `AbortSignal` or an `AgentLoop`.
 *
 * The load-bearing responsibility is what happens when the client dies: every
 * UI request still outstanding is settled with its own fallback. Nothing else
 * unblocks them — `ToolRunner.run` does not pass its abort signal into
 * `PermissionGate.approve`, so cancelling a turn leaves a pending prompt
 * pending, and the agent loop waits forever.
 */
export class SessionHost {
  private readonly channel: RuntimeChannel
  private readonly controller: SessionController
  private readonly runtimeSlot: RuntimeSlot
  private readonly project: ProjectRuntime
  private readonly scope: SessionScope
  private readonly workspace: PaneRegistry
  private readonly onPaneOpened: (pane: SessionPane, sessionId: string | undefined) => void
  private readonly onPaneClosed: (paneId: string) => void

  private readonly pendingUi = new PendingRequests<UiResponse>()
  /** Request kind per outstanding id, so each settles with its own fallback. */
  private readonly pendingKinds = new Map<string, UiRequest['kind']>()
  /** Kept host-side so `onAlwaysAllow` survives the round trip. */
  private readonly livePermissionRequests = new Map<string, PermissionRequest>()
  private readonly ledger: SessionRecordLedger
  /**
   * Messages the user submitted while a turn was running.
   *
   * Host-side rather than shell-side, unlike the terminal's — where `App.tsx`
   * owns the instance — because it is persisted through `store.appendRecord` and
   * because the pump's gate reads two things only this process knows: whether a
   * turn is in flight, and whether a blocking UI request is outstanding. Letting
   * a renderer own it would mean an `append-record` command, i.e. handing the
   * less-trusted end of this protocol the whole `SessionRecord` union.
   */
  private readonly messages: MessageQueue
  /** A pump run has dequeued but not finished handing off. See `canPumpQueue`. */
  private pumping = false
  private readonly teardown: Array<() => void> = []
  private session: SessionMeta
  private disposed = false
  private taskPostTimer: ReturnType<typeof setTimeout> | undefined

  constructor(deps: SessionHostDeps) {
    this.channel = deps.channel
    this.controller = deps.controller
    this.runtimeSlot = deps.runtimeSlot
    this.project = deps.project
    this.scope = deps.scope
    this.workspace = deps.workspace
    this.onPaneOpened = deps.onPaneOpened
    this.onPaneClosed = deps.onPaneClosed
    this.session = deps.scope.session
    this.ledger = new SessionRecordLedger(deps.scope.existingRecords)
    // Same three arguments the terminal passes (`App.tsx`), so a session's queue
    // replays identically whichever shell reopens it.
    this.messages = new MessageQueue(
      deps.scope.session.id,
      deps.scope.existingRecords,
      (sessionId, record) => this.project.store.appendRecord(sessionId, record),
    )

    this.teardown.push(this.controller.onEvent(this.forwardSessionEvent))
    this.teardown.push(this.controller.subscribe(this.postSnapshot))
    this.teardown.push(this.runtimeSlot.subscribe(this.postRuntimeSnapshot))
    // Plan-mode tools change the mode through PermissionGate without ever
    // touching RuntimeSlot, so without this the client's mode goes stale.
    this.teardown.push(this.scope.permissionGate.onModeChange(this.postRuntimeSnapshot))
    this.teardown.push(this.project.backgroundTasks.subscribe(this.scheduleBackgroundTaskPost))
    this.teardown.push(this.messages.subscribe(this.postQueuedMessages))
    this.teardown.push(this.channel.onMessage(this.handleMessage))
    this.teardown.push(this.channel.onClose(this.handleClose))

    this.attachBridges()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.taskPostTimer !== undefined) {
      clearTimeout(this.taskPostTimer)
      this.taskPostTimer = undefined
    }
    for (const off of this.teardown.splice(0)) off()
    this.detachBridges()
    this.settleAllUiRequests()
  }

  // --- outbound ---------------------------------------------------------

  private post(event: HostEvent): void {
    if (this.disposed) return
    this.channel.post(event)
  }

  private forwardSessionEvent = (event: SessionEvent): void => {
    if (event.type === 'record') {
      this.ledger.track(event.record)
    } else if (event.type === 'transcript-reset') {
      this.ledger.rebase(event.records)
    }
    this.post({ type: 'session-event', event })
  }

  private postSnapshot = (): void => {
    // Also the pump's main trigger: this fires when `streaming` flips back to
    // false, which is the moment a queued message becomes sendable.
    const cost = this.currentCost()
    this.post({
      type: 'snapshot',
      snapshot: this.controller.getSnapshot(),
      subagentProgress: [...this.controller.getSubagentProgress()],
      ...(cost ? { cost } : {}),
    })
    this.pumpQueue()
  }

  /**
   * Session cost, through the same projection `/cost` reads.
   *
   * Derived here because a renderer may not import `harness/` — the bargain
   * `PermissionRequestDto` already makes with its preview.
   */
  private currentCost(): WireUsageCost | undefined {
    const usage = resolveUsageWithCost(
      this.controller.getSnapshot().usage.total,
      this.runtimeSlot.current.modelConfig.pricing,
    )
    if (usage.cost === undefined) return undefined
    return { amount: usage.cost, currency: usage.currency ?? 'USD' }
  }

  /**
   * Announces the queue, and takes it as a cue to try the pump.
   *
   * Wired here rather than at each mutation so every path that can grow the queue
   * is covered by one edge: `enqueue-message`, the `hydrate` after a rewind, and
   * the `migrateTo` a `/clear` runs. Re-entrancy is safe — a pump in progress
   * dequeues, which notifies, which lands back here, where `canPumpQueue`'s
   * `running` guard turns it away.
   */
  private postQueuedMessages = (): void => {
    this.post({ type: 'queued-messages', messages: [...this.messages.getSnapshot()] })
    this.pumpQueue()
  }

  private postRuntimeSnapshot = (): void => {
    this.post({ type: 'runtime-snapshot', snapshot: this.buildRuntimeSnapshot() })
  }

  /**
   * `BackgroundTaskRegistry.changed()` fires on every output chunk of every
   * running shell. Posting each one would drown the channel, so collapse to at
   * most one message per macrotask and read the snapshot at flush time.
   */
  private scheduleBackgroundTaskPost = (): void => {
    if (this.disposed || this.taskPostTimer !== undefined) return
    this.taskPostTimer = setTimeout(() => {
      this.taskPostTimer = undefined
      this.postBackgroundTasks()
    }, 0)
    this.taskPostTimer.unref?.()
  }

  private postBackgroundTasks(): void {
    this.post({
      type: 'background-tasks',
      tasks: [...this.project.backgroundTasks.getSnapshot(this.session.id)],
    })
  }

  /** Metadata only — the live `AgentSession` and the endpoint's apiKey stay here. */
  private buildRuntimeSnapshot(): WireRuntimeSnapshot {
    const session = this.runtimeSlot.current
    return {
      modelKey: session.modelKey,
      model: session.modelConfig.model,
      providerName: session.providerName,
      ...(session.modelConfig.contextWindow !== undefined
        ? { contextWindow: session.modelConfig.contextWindow }
        : {}),
      ...(session.modelConfig.maxEffort !== undefined
        ? { maxEffort: session.modelConfig.maxEffort }
        : {}),
      effort: this.runtimeSlot.getEffort(),
      permissionMode: this.scope.permissionGate.getMode(),
    }
  }

  // --- the four blocking bridges ---------------------------------------

  private attachBridges(): void {
    const { bridges } = this.scope

    bridges.prompt.setPrompt(async (request) => {
      const requestId = randomUUID()
      this.livePermissionRequests.set(requestId, request)
      try {
        const response = await this.askUi({
          kind: 'permission',
          requestId,
          payload: toPermissionDto(request, { cwd: this.project.cwd }),
        })
        if (response.kind !== 'permission') return false
        // Must run before we resolve: PermissionGate reads the captured
        // "always allow" flag on the statement right after this await returns.
        if (response.alwaysAllow) request.onAlwaysAllow?.()
        return response.approved
      } finally {
        this.livePermissionRequests.delete(requestId)
      }
    })

    bridges.askUserQuestion.setOpen(async (payload) => {
      const response = await this.askUi({
        kind: 'ask-user-question',
        requestId: randomUUID(),
        payload,
      })
      return response.kind === 'ask-user-question'
        ? response.result
        : { kind: 'rejected', feedback: 'The UI disconnected before answering.' }
    })

    bridges.enterPlan.setOpen(async () => {
      const response = await this.askUi({ kind: 'enter-plan', requestId: randomUUID() })
      // Entering plan mode only restricts the agent, so a lost client approves.
      return response.kind === 'enter-plan' ? response.approved : true
    })

    bridges.exitPlan.setOpen(async (payload) => {
      const response = await this.askUi({
        kind: 'exit-plan',
        requestId: randomUUID(),
        payload,
      })
      return response.kind === 'exit-plan'
        ? response.decision
        : { kind: 'reject', feedback: '' }
    })
  }

  private detachBridges(): void {
    const { bridges } = this.scope
    bridges.prompt.clearPrompt()
    bridges.askUserQuestion.setOpen(async () => ({
      kind: 'rejected',
      feedback: 'AskUserQuestion UI is not mounted.',
    }))
    bridges.enterPlan.setOpen(async () => true)
    bridges.exitPlan.setOpen(async () => ({ kind: 'reject', feedback: '' }))
  }

  private askUi(request: UiRequest): Promise<UiResponse> {
    if (this.disposed) return Promise.resolve(UI_REQUEST_FALLBACKS[request.kind]())
    const pending = this.pendingUi.create(request.requestId)
    this.pendingKinds.set(request.requestId, request.kind)
    this.post({ type: 'ui-request', request })
    return pending.finally(() => {
      this.pendingKinds.delete(request.requestId)
      // A dialog closing can unblock the pump; nothing else notices that.
      this.pumpQueue()
    })
  }

  // --- the message queue ------------------------------------------------

  /**
   * Sends the next queued message, if the gate lets it through.
   *
   * The policy is `canPumpQueue`, shared with the terminal so the domain rule —
   * one at a time, never during a turn — cannot fork. Only `uiBlocked` differs
   * between the shells, and this is where the desktop's answer lives: a pending
   * *blocking* request, not any open panel. The `/rewind` panel and the pickers
   * hold the user, not the agent loop, so they do not stop the queue.
   *
   * Fire-and-forget by design. Every trigger (an enqueue, a turn ending, a
   * dialog being answered) is a place that must not wait for a whole turn, so
   * the work is detached and the tail re-checks rather than looping: after an
   * await this is a fresh microtask, not recursion.
   *
   * Because it is detached, both `disposed` checks below are defence in depth
   * rather than load-bearing, and it is worth knowing which is which. What
   * actually stops a closed pane from pumping is `dispose()` draining
   * `this.teardown`, which unsubscribes the snapshot and queue listeners — remove
   * either check by mutation and the suite stays green, because nothing calls this
   * afterwards. They are kept for the same reason `post()` carries one: the cost
   * is a branch, and the failure they guard against is a real turn starting on a
   * host nobody is listening to, with the bridges already detached so every
   * permission prompt inside it auto-denies. The second one, after the await,
   * covers a race the suite cannot hit deterministically — `dequeue()` writes to
   * disk, and a `dispose()` landing inside that await is past the first check.
   * Losing the dequeued message when the window closes is the lesser evil, and
   * matches what a Ctrl+C mid-pump does in the terminal.
   */
  private pumpQueue(): void {
    if (this.disposed) return
    if (!canPumpQueue({
      pending: this.messages.getSnapshot().length,
      running: this.pumping,
      turnActive: this.controller.getSnapshot().isStreaming,
      uiBlocked: this.pendingKinds.size > 0,
    })) return

    this.pumping = true
    void (async () => {
      try {
        const next = await this.messages.dequeue()
        if (next && !this.disposed) await this.controller.submit(next.content)
      } catch (error) {
        // Synthesized rather than routed through the controller: the message
        // never became a turn, so there is no turn to attach a notice to. Same
        // shape `applySessionSwitch` posts for its startup notices.
        this.post({
          type: 'session-event',
          event: {
            type: 'notice',
            level: 'error',
            content: `Failed to send queued message: ${error instanceof Error ? error.message : String(error)}`,
          },
        })
      } finally {
        this.pumping = false
        // More may be waiting, and the turn that just ended already fired its
        // own `postSnapshot` while this flag was still set.
        this.pumpQueue()
      }
    })()
  }

  /**
   * Every kind gets its own fallback, so this cannot be one blanket
   * `settleAll`. The asymmetry is deliberate; see `UI_REQUEST_FALLBACKS`.
   */
  private settleAllUiRequests(): void {
    for (const [requestId, kind] of [...this.pendingKinds]) {
      this.pendingUi.settle(requestId, UI_REQUEST_FALLBACKS[kind]())
    }
    this.pendingKinds.clear()
  }

  private handleClose = (): void => {
    this.dispose()
  }

  // --- inbound ----------------------------------------------------------

  private handleMessage = (message: unknown): void => {
    const parsed = parseHostCommand(message)
    if (!parsed.ok) {
      this.rejectMalformed(parsed)
      return
    }

    const command = parsed.command
    if (command.type === 'ui-response') {
      this.pendingUi.settle(command.requestId, command.response)
      return
    }

    void this.runCommand(command)
  }

  /**
   * A malformed message must not simply vanish. Both halves of this protocol
   * park a promise waiting for an answer, so silence is the one outcome that
   * hangs something: a command's `send()` never settles until the channel dies,
   * and an unanswered permission prompt blocks the agent loop outright --
   * `ToolRunner.run` does not pass its abort signal into
   * `PermissionGate.approve`, so interrupting the turn will not release it
   * either.
   *
   * A message too broken to carry an id is still dropped, as before: there is
   * nowhere to send the answer.
   */
  private rejectMalformed(failure: HostCommandParseFailure): void {
    if (failure.requestId !== undefined) {
      const kind = this.pendingKinds.get(failure.requestId)
      // Its own fallback rather than a blanket denial: `UI_REQUEST_FALLBACKS`
      // is asymmetric on purpose, and a renderer that answers garbage is not
      // distinguishable from one that has gone away.
      if (kind) this.pendingUi.settle(failure.requestId, UI_REQUEST_FALLBACKS[kind]())
      return
    }
    if (failure.id !== undefined) {
      this.post({ type: 'fail', id: failure.id, message: failure.message })
    }
  }

  private async runCommand(command: Exclude<HostCommand, { type: 'ui-response' }>): Promise<void> {
    try {
      const result = await this.execute(command)
      this.post({ type: 'reply', id: command.id, result })
    } catch (error) {
      this.post({
        type: 'fail',
        id: command.id,
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  private async execute(command: Exclude<HostCommand, { type: 'ui-response' }>): Promise<unknown> {
    switch (command.type) {
      case 'hello': {
        this.postSnapshot()
        this.postRuntimeSnapshot()
        this.postBackgroundTasks()
        this.postQueuedMessages()
        const queued = resolveInitialQueuedPrompt(this.scope.hasRecoverableInterruption)
        return {
          sessionId: this.session.id,
          session: this.session,
          cwd: this.project.cwd,
          records: [...this.ledger.list()],
          notices: this.startupNotices(this.scope.diagnostics),
          hasRecoverableInterruption: this.scope.hasRecoverableInterruption,
          ...(queued ? { initialQueuedPrompt: queued } : {}),
          queuedMessages: [...this.messages.getSnapshot()],
          configuredEffortLevel: this.project.configuredEffortLevel,
        } satisfies WireHelloResult
      }

      case 'submit':
        await this.controller.submit(command.input, this.resolveOverrides(command.overrides))
        return null

      case 'interrupt':
        this.controller.interrupt(command.reason)
        return null

      case 'reload': {
        const records = await this.controller.reload()
        this.ledger.rebase(records)
        return { records }
      }

      case 'retarget':
        return this.applySessionSwitch(await switchToExistingSession(
          // `reset`, not `migrateTo`: `/resume` goes *to* an existing session,
          // which has a queue of its own replayed from its own log. Carrying this
          // session's pending messages over would put them in a conversation the
          // user did not write them for.
          this.switchDeps((next, records) => this.messages.reset(next.id, records)),
          command.sessionId,
        ))

      case 'create-session':
        return this.applySessionSwitch(await switchToNewSession(
          // `migrateTo`, because `/clear` is the same conversation continuing in a
          // fresh log: anything queued but unsent still means what it meant, and
          // the compensating `clear` goes to the *old* session's log so a later
          // replay cannot resurrect it.
          this.switchDeps((next) => this.messages.migrateTo(next.id, [])),
          {
            previousSessionId: this.session.id,
            ...(command.title ? { title: command.title } : {}),
          },
        ))

      case 'run-tool': {
        const result = await this.runtimeSlot.current.loop.runTool({
          id: randomUUID(),
          name: command.name,
          input: command.input,
        })
        return {
          ok: result.ok,
          content: result.content,
          ...(result.errorCode ? { errorCode: result.errorCode } : {}),
        }
      }

      case 'run-command':
        return this.runSlashCommand(command.input)

      case 'list-commands':
        // Already filtered for `isHidden`/`isEnabled` by the registry.
        return { commands: this.project.commands.list().map(toWireCommandInfo) } satisfies WireCommandsResult

      case 'file-suggestions': {
        // Built field by field rather than forwarded: `createFileSuggestion` is
        // free to grow a field, and a spread would put it on the wire without
        // anyone deciding to. `metadata` is rebuilt for the same reason.
        const suggestions = await generateFileSuggestions(
          command.input,
          command.cursorPos,
          this.project.cwd,
        )
        return {
          suggestions: suggestions.map((suggestion) => ({
            id: suggestion.id,
            displayText: suggestion.displayText,
            ...(suggestion.description === undefined ? {} : { description: suggestion.description }),
            metadata: {
              replacementText: suggestion.metadata.replacementText,
              path: suggestion.metadata.path,
              kind: suggestion.metadata.kind,
            },
          })),
        } satisfies WireFileSuggestionsResult
      }

      case 'checkpoints':
        return { checkpoints: await this.controller.getCheckpointService().getCheckpointsWithDiffs() }

      case 'restore-code':
        return this.controller.getCheckpointService().restoreToCommit(command.commitHash)

      case 'truncate-session': {
        const result = await this.project.store.truncateBeforeMessage(this.session.id, command.messageId)
        // Thrown rather than reported: a rewind that silently did nothing would
        // leave the caller showing a transcript the file no longer matches.
        if (!result.success) throw new Error(result.error ?? 'Failed to truncate session')
        return { records: await this.afterRewind() } satisfies WireRewindResult
      }

      case 'summarize-rewind': {
        const loaded = await this.project.store.loadRecordsWithDiagnostics(this.session.id)
        const rewrite = await buildRewindSummaryRewrite({
          records: loaded.records,
          targetMessageId: command.messageId,
          decision: command.decision,
          // Goes through `AgentLoop.enqueue`, the same single in-flight slot as
          // `run()`. Sent mid-turn it waits for that turn to finish, so this
          // reply can be arbitrarily slow; nothing about it is a fast path.
          summarize: (records) => this.runtimeSlot.current.loop.summarizeRecordsForRewind(records),
        })
        await this.project.store.replaceRecords(this.session.id, rewrite.nextRecords)
        return { records: await this.afterRewind() } satisfies WireRewindResult
      }

      case 'set-model': {
        const next = this.scope.createRuntime(command.modelKey, this.session, this.ledger.list())
        // Clearing before the swap: the cached Environment section embeds the
        // model name, so a stale prefix would survive into the next request.
        this.runtimeSlot.current.loop.clearCachedSections()
        this.runtimeSlot.replace(next)
        const effort = this.runtimeSlot.reapplyEffort()
        this.postRuntimeSnapshot()
        return { modelKey: command.modelKey, effort }
      }

      case 'set-effort': {
        const applied = this.runtimeSlot.setEffort(command.level)
        let persisted = false
        if (command.persist && isEffortLevel(applied)) {
          try {
            await saveEffortLevel(applied)
            persisted = true
          } catch {
            // Non-critical, and the live slot already took the change.
          }
        }
        this.postRuntimeSnapshot()
        return { effort: applied, persisted } satisfies WireEffortResult
      }

      case 'set-permission-mode': {
        const applied = applyPermissionModeTransition(
          this.scope.permissionGate,
          this.runtimeSlot.current.planModeManager,
          command.mode,
        )
        this.postRuntimeSnapshot()
        return { mode: applied }
      }

      case 'list-models':
        return this.buildModelsResult()

      case 'resolve-model': {
        const modelKey = this.project.config.resolveModelInput(command.input, {
          currentModelKey: this.runtimeSlot.current.modelKey,
        })
        return { ...(modelKey ? { modelKey } : {}) } satisfies WireResolveModelResult
      }

      case 'set-default-model': {
        this.project.config.setDefaultModel(command.reference)
        await this.project.config.save()
        return this.buildModelsResult()
      }

      case 'list-sessions':
        return { sessions: await this.project.store.list() } satisfies WireSessionsResult

      case 'reload-agents':
        return { count: await this.project.reloadAgentDefinitions() } satisfies WireReloadCountResult

      case 'reload-skills':
        return { count: await this.project.reloadSkills() } satisfies WireReloadCountResult

      case 'reload-settings': {
        const { needsRuntimeRebuild } = await this.project.reloadSettings()
        if (!needsRuntimeRebuild) {
          return {
            needsRuntimeRebuild,
            rebuilt: false,
            modelKey: this.runtimeSlot.current.modelKey,
          } satisfies WireReloadSettingsResult
        }
        // Rebuilt here rather than asked of the client: that hooks are captured
        // at runtime-construction time is host trivia a renderer should not know.
        const currentKey = this.runtimeSlot.current.modelKey
        const nextKey = resolveRuntimeModelKeyAfterConfigChange(this.project.config, currentKey, 'models')
          ?? currentKey
        const next = this.scope.createRuntime(nextKey, this.session, this.ledger.list())
        this.runtimeSlot.current.loop.clearCachedSections()
        this.runtimeSlot.replace(next)
        this.runtimeSlot.reapplyEffort()
        this.postRuntimeSnapshot()
        return { needsRuntimeRebuild, rebuilt: true, modelKey: nextKey } satisfies WireReloadSettingsResult
      }

      case 'list-background-tasks':
        return {
          tasks: [...this.project.backgroundTasks.getSnapshot(this.session.id)],
        } satisfies WireBackgroundTasksResult

      case 'peek-task-output':
        return {
          output: this.project.backgroundTasks.peekOutput(
            this.session.id,
            command.taskId,
            command.maxBytes,
          ),
        } satisfies WireTaskOutputResult

      case 'kill-task': {
        const task = await this.project.backgroundTasks.killShell(
          this.session.id,
          command.taskId,
          command.reason,
        )
        return { ...(task ? { task } : {}) } satisfies WireTaskResult
      }

      case 'shutdown':
        await this.project.shutdown(command.reason)
        return { ok: true }

      case 'open-pane':
        return this.handleOpenPane(command)

      case 'close-pane':
        return this.handleClosePane(command)

      case 'list-panes':
        return this.handleListPanes() satisfies WireListPanesResult

      case 'enqueue-message': {
        // `MessageQueue` notifies its subscribers, and `postQueuedMessages` both
        // announces the new list and asks the pump — so an idle host has already
        // started sending this by the time the reply goes out.
        const message = await this.messages.enqueue(command.content, command.priority)
        return { message } satisfies WireEnqueueResult
      }

      case 'clear-queue':
        await this.messages.clear()
        return { ok: true }
    }

    // Not a `default` branch, and it must not become one. The switch above has
    // to stay exhaustive so a new HostCommand variant is a compile error rather
    // than a silent reply; this line is what makes that true, because the
    // declared return type `Promise<unknown>` already admits the `undefined`
    // that falling out of the switch produces. Unreachable at runtime --
    // `parseHostCommand` rejects anything outside the union -- and if it ever
    // is reached, `runCommand`'s catch turns it into a `fail`.
    return assertNever(command)
  }

  /**
   * `useCommands.dispatch`, minus React.
   *
   * The tolerance is copied deliberately: an unknown command and a command that
   * threw both come back as `handled` with a `write-line` explaining why, because
   * that is what the TUI does and a slash command failing is not a protocol
   * failure. Only input that is not a slash command at all is unhandled.
   */
  private async runSlashCommand(input: string): Promise<WireRunCommandResult> {
    if (!input.startsWith('/')) return { handled: false }

    const spaceIndex = input.indexOf(' ')
    const name = spaceIndex >= 0 ? input.slice(1, spaceIndex) : input.slice(1)
    const args = spaceIndex >= 0 ? input.slice(spaceIndex + 1).trim() : ''

    // The shell owns its own teardown; it calls `shutdown` when it is ready.
    if (name === 'exit') return { handled: true, exit: true }

    const command = this.project.commands.get(name)
    if (!command) {
      this.emitCommandEffect({
        kind: 'write-line',
        text: `Unknown command: /${name}. Type /help for available commands.`,
      })
      return { handled: true }
    }

    try {
      await command.run(args, this.commandContext())
    } catch (error) {
      this.emitCommandEffect({
        kind: 'write-line',
        text: `Command error: ${error instanceof Error ? error.message : String(error)}`,
      })
    }
    return { handled: true }
  }

  private emitCommandEffect = (effect: CommandEffect): void => {
    this.post({ type: 'command-effect', effect })
  }

  /**
   * Rebuilt per command rather than cached: `getSession` and `getRecords` close
   * over `this`, so a command that switches sessions mid-run still reads the new
   * one back.
   */
  private commandContext(): CommandContext {
    return createHostCommandContext({
      project: this.project,
      scope: this.scope,
      runtimeSlot: this.runtimeSlot,
      controller: this.controller,
      getSession: () => this.session,
      getRecords: () => this.ledger.list(),
      startNewSession: async () => {
        // Same `migrateTo` as the `create-session` command: `/clear` arrives
        // through here, and a queue left keyed to the old session would pump into
        // the new one.
        this.applySessionSwitch(await switchToNewSession(
          this.switchDeps((next) => this.messages.migrateTo(next.id, [])),
          { previousSessionId: this.session.id },
        ))
      },
      emit: this.emitCommandEffect,
    })
  }

  /**
   * The tail both rewind commands share once the file on disk has changed.
   *
   * `invalidateRecordsCache` first, or the loop keeps serving the pre-rewind
   * records it already read. `reload()` re-reads and emits the
   * `transcript-reset` that repaints the view, and the ledger has to be rebased
   * off the same list -- a stale ledger would fold the discarded records back
   * into the next runtime `set-model` or `reload-settings` builds.
   */
  private async afterRewind(): Promise<SessionRecord[]> {
    this.runtimeSlot.current.loop.invalidateRecordsCache()
    const records = await this.controller.reload()
    this.ledger.rebase(records)
    // The rewind may have cut away the `message_queue` records the live queue was
    // built from, so it is replayed off the new list rather than trusted.
    await this.messages.hydrate(records)
    return records
  }

  private switchDeps(
    beforeApply?: (session: SessionMeta, records: readonly SessionRecord[]) => Promise<void>,
  ): SessionSwitchDeps {
    return {
      // One field from each half rather than the merged host: switching a
      // session needs the project's store and *this* scope's runtime factory.
      host: { store: this.project.store, createRuntime: this.scope.createRuntime },
      runtimeSlot: this.runtimeSlot,
      controller: this.controller,
      backgroundTasks: this.project.backgroundTasks,
      // Rebinding the message queue has to happen here rather than after the
      // switch returns: past `RuntimeSlot.replace` there is an await boundary on
      // which a queue still keyed to the old session could pump into the new one.
      ...(beforeApply ? { beforeApply } : {}),
    }
  }

  private applySessionSwitch(result: SessionSwitchResult): WireSessionSwitchResult {
    this.session = result.session
    this.ledger.rebase(result.records)
    const notices = this.startupNotices(result.diagnostics)
    // Pushed rather than left to the reply: a `/clear` arriving as a
    // `run-command` switches the session too, and only the host knows the draft
    // id it just minted.
    this.post({ type: 'session-changed', session: result.session })
    // The event stream stays the single source of transcript truth; the reply
    // carries the same records only for convenience.
    this.post({
      type: 'session-event',
      event: {
        type: 'transcript-reset',
        records: result.records,
        systemMessages: notices.map((notice) => notice.content),
        bumpGeneration: true,
      },
    })
    this.postBackgroundTasks()
    this.postRuntimeSnapshot()
    // Unconditional rather than left to `MessageQueue`'s own subscription: a
    // switch between two empty queues changes nothing it would notify about, and
    // the client still needs to hear that the list it is showing now belongs to a
    // different session.
    this.postQueuedMessages()
    return { session: result.session, records: result.records, notices }
  }

  /**
   * Diagnostics folded together with the project's MCP status.
   *
   * Kept here rather than inside `switchToExistingSession`: only a host has the
   * MCP status, and a terminal shell shows the diagnostics without it.
   */
  private startupNotices(diagnostics: RuntimeDiagnostic[]): StartupNotice[] {
    return buildStartupNotices({ diagnostics, mcp: this.project.mcp })
  }

  private buildModelsResult(): WireModelsResult {
    const configured = this.project.config.get().models
    const models: WireModelInfo[] = Object.keys(configured).map((key) => {
      // Field by field, never a spread: resolveModel folds the endpoint's
      // apiKey and baseUrl into what it returns.
      const resolved = this.project.config.getModel(key)
      const info: WireModelInfo = { key }
      if (resolved?.model !== undefined) info.model = resolved.model
      if (resolved?.provider !== undefined) info.provider = resolved.provider
      if (resolved?.contextWindow !== undefined) info.contextWindow = resolved.contextWindow
      if (resolved?.maxEffort !== undefined) info.maxEffort = resolved.maxEffort
      return info
    })
    const defaultModelKey = this.project.config.resolveModelReference(this.project.config.get().defaultModel)
    const pickerOptions = buildModelPickerOptions(
      this.project.config,
      this.runtimeSlot.current.modelKey,
      Object.keys(configured),
    )
    return { models, pickerOptions, ...(defaultModelKey ? { defaultModelKey } : {}) }
  }

  /** Turns wire overrides back into the live objects the loop expects. */
  private resolveOverrides(overrides: WireRunOverrides | undefined) {
    if (!overrides) return undefined
    const { modelKey, ...rest } = overrides
    return {
      ...rest,
      ...(modelKey ? { model: this.project.createActiveModelRuntime(modelKey) } : {}),
    }
  }

  /** Exposed for hosts that need the ledger (model switches fold it into task state). */
  getRecords(): readonly SessionRecord[] {
    return this.ledger.list()
  }

  // --- pane (multi-tab) handlers ----------------------------------------

  /**
   * Resolves the requested pane and asks the shell to open a window for it.
   *
   * The split is the same as everywhere else in this file: the host owns
   * runtime and persistence, the shell owns the `BrowserWindow`. The host
   * resolves the pane and registers it in the workspace **before** handing
   * off, so the shell sees a pane by the time it iterates `workspace.list()`
   * (notably during its own initial setup).
   *
   * `paneId` is the session id: a pane is identified by the session it is
   * bound to (one pane per session), and a renderer's `close-pane` carries
   * the same value the renderer sees in `WirePaneInfo.paneId`.
   */
  private async handleOpenPane(
    command: Extract<HostCommand, { type: 'open-pane' }>,
  ): Promise<WireOpenPaneResult> {
    let pane: SessionPane
    if (command.sessionId) {
      // `paneForSession` is the one-pane-per-session invariant: returning the
      // existing pane is the whole point, since two panes on one session id
      // means two `AgentLoop`s appending to one JSONL.
      const existing = this.workspace.paneForSession(command.sessionId)
      if (existing) {
        pane = existing
      } else {
        const session = await this.project.store.resolve(command.sessionId)
        if (!session) throw new Error(`Session not found: ${command.sessionId}`)
        pane = await this.workspace.open(session)
      }
    } else {
      const scope = await this.project.openScope(this.project.store.createDraft(command.title))
      pane = this.workspace.adopt(scope, {})
    }

    const session = pane.getSession()
    const records = await this.project.store.loadRecordsWithDiagnostics(session.id)

    // The callback is what wires the new pane's `BrowserWindow` and builds
    // its `SessionHost`. We post the topology update **after** the shell has
    // finished construction so the listing is never ahead of reality.
    this.onPaneOpened(pane, command.sessionId)
    this.broadcastPaneList()

    return {
      paneId: session.id,
      session,
      records: records.records,
      notices: this.startupNotices(records.diagnostics),
    }
  }

  /**
   * Looks the pane up by id, then runs the fixed teardown order. The shell
   * detaches the window in response to the callback — the host does not
   * touch `BrowserWindow`s.
   *
   * Throwing on an unknown pane keeps the symmetry with `retarget`: a
   * renderer that has gone stale is better off getting a fail than a silent
   * no-op.
   */
  private handleClosePane(command: Extract<HostCommand, { type: 'close-pane' }>): WireClosePaneResult {
    const pane = this.workspace.list().find((candidate) => candidate.getSession().id === command.paneId)
    if (!pane) throw new Error(`Pane not found: ${command.paneId}`)
    this.workspace.close(pane)
    this.onPaneClosed(command.paneId)
    this.broadcastPaneList()
    return { ok: true }
  }

  /** Pane topology snapshot. The shape mirrors the `pane-list` event intentionally. */
  private handleListPanes(): WireListPanesResult {
    return { panes: this.collectPanes() }
  }

  /**
   * Pushes the current pane topology to every connected renderer.
   *
   * Only this host's channel is reachable here, so a true multi-pane broadcast
   * is the shell's job (it iterates every `SessionHost`). What this host does
   * is post to its own channel, which is the only pane that ever sees its own
   * `open-pane` / `close-pane` replies and therefore the one that needs the
   * update most.
   */
  private broadcastPaneList(): void {
    this.post({ type: 'pane-list', panes: this.collectPanes() })
  }

  /** Field-by-field projection. Never spread `SessionPane` — see `WirePaneInfo`. */
  private collectPanes(): WirePaneInfo[] {
    return this.workspace.list().map((pane) => {
      const session = pane.getSession()
      const info: WirePaneInfo = { paneId: session.id, sessionId: session.id }
      if (session.title !== undefined) info.sessionTitle = session.title
      return info
    })
  }
}
