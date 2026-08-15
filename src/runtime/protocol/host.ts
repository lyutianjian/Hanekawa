import { randomUUID } from 'node:crypto'
import { VALID_EFFORT_LEVELS, type EffortLevel } from '../../config/effort.js'
import { saveEffortLevel } from '../../config/settings.js'
import type { PermissionRequest } from '../../harness/permissions.js'
import type { SessionRecord } from '../../harness/types.js'
import type { SessionMeta } from '../../sessions/service.js'
import { applyPermissionModeTransition } from '../permissionMode.js'
import { resolveRuntimeModelKeyAfterConfigChange } from '../providerRuntime.js'
import { SessionRecordLedger } from '../recordLedger.js'
import type { RuntimeSlot } from '../runtimeSlot.js'
import type { SessionController, SessionEvent } from '../sessionController.js'
import {
  switchToExistingSession,
  switchToNewSession,
  type SessionSwitchDeps,
  type SessionSwitchResult,
} from '../sessionSwitch.js'
import { buildStartupNotices, resolveInitialQueuedPrompt } from '../startupNotices.js'
import type { RuntimeHost } from '../types.js'
import type { RuntimeChannel } from './channel.js'
import { parseHostCommand, type HostCommandParseFailure } from './commandSchema.js'
import { PendingRequests } from './pendingRequests.js'
import { toPermissionDto } from './permissionDto.js'
import {
  UI_REQUEST_FALLBACKS,
  type HostCommand,
  type HostEvent,
  type UiRequest,
  type UiResponse,
  type WireBackgroundTasksResult,
  type WireEffortResult,
  type WireHelloResult,
  type WireModelInfo,
  type WireModelsResult,
  type WireReloadCountResult,
  type WireReloadSettingsResult,
  type WireResolveModelResult,
  type WireRunOverrides,
  type WireRuntimeSnapshot,
  type WireSessionSwitchResult,
  type WireSessionsResult,
  type WireTaskOutputResult,
  type WireTaskResult,
} from './wire.js'

function isEffortLevel(value: string): value is EffortLevel {
  return (VALID_EFFORT_LEVELS as readonly string[]).includes(value)
}

function assertNever(value: never): never {
  throw new Error(`Unhandled host command: ${JSON.stringify(value)}`)
}

export interface SessionHostDeps {
  channel: RuntimeChannel
  controller: SessionController
  runtimeSlot: RuntimeSlot
  host: RuntimeHost
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
  private readonly host: RuntimeHost

  private readonly pendingUi = new PendingRequests<UiResponse>()
  /** Request kind per outstanding id, so each settles with its own fallback. */
  private readonly pendingKinds = new Map<string, UiRequest['kind']>()
  /** Kept host-side so `onAlwaysAllow` survives the round trip. */
  private readonly livePermissionRequests = new Map<string, PermissionRequest>()
  private readonly ledger: SessionRecordLedger
  private readonly teardown: Array<() => void> = []
  private session: SessionMeta
  private disposed = false
  private taskPostTimer: ReturnType<typeof setTimeout> | undefined

  constructor(deps: SessionHostDeps) {
    this.channel = deps.channel
    this.controller = deps.controller
    this.runtimeSlot = deps.runtimeSlot
    this.host = deps.host
    this.session = deps.host.session
    this.ledger = new SessionRecordLedger(deps.host.existingRecords)

    this.teardown.push(this.controller.onEvent(this.forwardSessionEvent))
    this.teardown.push(this.controller.subscribe(this.postSnapshot))
    this.teardown.push(this.runtimeSlot.subscribe(this.postRuntimeSnapshot))
    // Plan-mode tools change the mode through PermissionGate without ever
    // touching RuntimeSlot, so without this the client's mode goes stale.
    this.teardown.push(this.host.permissionGate.onModeChange(this.postRuntimeSnapshot))
    this.teardown.push(this.host.backgroundTasks.subscribe(this.scheduleBackgroundTaskPost))
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
    this.post({
      type: 'snapshot',
      snapshot: this.controller.getSnapshot(),
      subagentProgress: [...this.controller.getSubagentProgress()],
    })
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
      tasks: [...this.host.backgroundTasks.getSnapshot(this.session.id)],
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
      permissionMode: this.host.permissionGate.getMode(),
    }
  }

  // --- the four blocking bridges ---------------------------------------

  private attachBridges(): void {
    const { bridges } = this.host

    bridges.prompt.setPrompt(async (request) => {
      const requestId = randomUUID()
      this.livePermissionRequests.set(requestId, request)
      try {
        const response = await this.askUi({
          kind: 'permission',
          requestId,
          payload: toPermissionDto(request, { cwd: this.host.cwd }),
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
    const { bridges } = this.host
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
    })
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
        const queued = resolveInitialQueuedPrompt(this.host.hasRecoverableInterruption)
        return {
          sessionId: this.session.id,
          session: this.session,
          cwd: this.host.cwd,
          records: [...this.ledger.list()],
          notices: buildStartupNotices(this.host),
          hasRecoverableInterruption: this.host.hasRecoverableInterruption,
          ...(queued ? { initialQueuedPrompt: queued } : {}),
          configuredEffortLevel: this.host.configuredEffortLevel,
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
        return this.applySessionSwitch(await switchToExistingSession(this.switchDeps(), command.sessionId))

      case 'create-session':
        return this.applySessionSwitch(await switchToNewSession(this.switchDeps(), {
          previousSessionId: this.session.id,
          ...(command.title ? { title: command.title } : {}),
        }))

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

      case 'checkpoints':
        return { checkpoints: await this.controller.getCheckpointService().getCheckpointsWithDiffs() }

      case 'restore-code':
        return this.controller.getCheckpointService().restoreToCommit(command.commitHash)

      case 'set-model': {
        const next = this.host.createRuntime(command.modelKey, this.session, this.ledger.list())
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
          this.host.permissionGate,
          this.runtimeSlot.current.planModeManager,
          command.mode,
        )
        this.postRuntimeSnapshot()
        return { mode: applied }
      }

      case 'list-models':
        return this.buildModelsResult()

      case 'resolve-model': {
        const modelKey = this.host.config.resolveModelInput(command.input, {
          currentModelKey: this.runtimeSlot.current.modelKey,
        })
        return { ...(modelKey ? { modelKey } : {}) } satisfies WireResolveModelResult
      }

      case 'set-default-model': {
        this.host.config.setDefaultModel(command.reference)
        await this.host.config.save()
        return this.buildModelsResult()
      }

      case 'list-sessions':
        return { sessions: await this.host.store.list() } satisfies WireSessionsResult

      case 'reload-agents':
        return { count: await this.host.reloadAgentDefinitions() } satisfies WireReloadCountResult

      case 'reload-skills':
        return { count: await this.host.reloadSkills() } satisfies WireReloadCountResult

      case 'reload-settings': {
        const { needsRuntimeRebuild } = await this.host.reloadSettings()
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
        const nextKey = resolveRuntimeModelKeyAfterConfigChange(this.host.config, currentKey, 'models')
          ?? currentKey
        const next = this.host.createRuntime(nextKey, this.session, this.ledger.list())
        this.runtimeSlot.current.loop.clearCachedSections()
        this.runtimeSlot.replace(next)
        this.runtimeSlot.reapplyEffort()
        this.postRuntimeSnapshot()
        return { needsRuntimeRebuild, rebuilt: true, modelKey: nextKey } satisfies WireReloadSettingsResult
      }

      case 'list-background-tasks':
        return {
          tasks: [...this.host.backgroundTasks.getSnapshot(this.session.id)],
        } satisfies WireBackgroundTasksResult

      case 'peek-task-output':
        return {
          output: this.host.backgroundTasks.peekOutput(
            this.session.id,
            command.taskId,
            command.maxBytes,
          ),
        } satisfies WireTaskOutputResult

      case 'kill-task': {
        const task = await this.host.backgroundTasks.killShell(
          this.session.id,
          command.taskId,
          command.reason,
        )
        return { ...(task ? { task } : {}) } satisfies WireTaskResult
      }

      case 'shutdown':
        await this.host.shutdown(command.reason)
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

  private switchDeps(): SessionSwitchDeps {
    return {
      host: this.host,
      runtimeSlot: this.runtimeSlot,
      controller: this.controller,
      backgroundTasks: this.host.backgroundTasks,
    }
  }

  private applySessionSwitch(result: SessionSwitchResult): WireSessionSwitchResult {
    this.session = result.session
    this.ledger.rebase(result.records)
    // The event stream stays the single source of transcript truth; the reply
    // carries the same records only for convenience.
    this.post({
      type: 'session-event',
      event: {
        type: 'transcript-reset',
        records: result.records,
        systemMessages: result.notices.map((notice) => notice.content),
        bumpGeneration: true,
      },
    })
    this.postBackgroundTasks()
    this.postRuntimeSnapshot()
    return result
  }

  private buildModelsResult(): WireModelsResult {
    const configured = this.host.config.get().models
    const models: WireModelInfo[] = Object.keys(configured).map((key) => {
      // Field by field, never a spread: resolveModel folds the endpoint's
      // apiKey and baseUrl into what it returns.
      const resolved = this.host.config.getModel(key)
      const info: WireModelInfo = { key }
      if (resolved?.model !== undefined) info.model = resolved.model
      if (resolved?.provider !== undefined) info.provider = resolved.provider
      if (resolved?.contextWindow !== undefined) info.contextWindow = resolved.contextWindow
      if (resolved?.maxEffort !== undefined) info.maxEffort = resolved.maxEffort
      return info
    })
    const defaultModelKey = this.host.config.resolveModelReference(this.host.config.get().defaultModel)
    return { models, ...(defaultModelKey ? { defaultModelKey } : {}) }
  }

  /** Turns wire overrides back into the live objects the loop expects. */
  private resolveOverrides(overrides: WireRunOverrides | undefined) {
    if (!overrides) return undefined
    const { modelKey, ...rest } = overrides
    return {
      ...rest,
      ...(modelKey ? { model: this.host.createActiveModelRuntime(modelKey) } : {}),
    }
  }

  /** Exposed for hosts that need the ledger (model switches fold it into task state). */
  getRecords(): readonly SessionRecord[] {
    return this.ledger.list()
  }
}
