import { randomUUID } from 'node:crypto'
import type {
  CommandContext,
  CommandModelInfo,
  CommandUsage,
  SetModelResult,
} from '../../commands/types.js'
import { resetAutoCompactFailureState } from '../../harness/compact.js'
import type { SessionRecord } from '../../harness/types.js'
import { resolveUsageWithCost } from '../../harness/usage.js'
import type { SessionMeta } from '../../sessions/service.js'
import { switchModel, type ModelSwitchDeps } from '../modelSwitch.js'
import { applyPermissionModeTransition } from '../permissionMode.js'
import { openPlanFileInEditor, readCurrentPlanFile } from '../planFile.js'
import { buildRunOverrides } from '../runOverrides.js'
import type { RuntimeSlot } from '../runtimeSlot.js'
import type { SessionController } from '../sessionController.js'
import {
  cleanupSubagentWorktrees,
  getSubagentDetails,
  listLatestSubagentTasks,
} from '../subagentInspection.js'
import type { ProjectRuntime, SessionScope } from '../types.js'
import type { CommandEffect } from './wire.js'

/**
 * A `CommandContext` assembled entirely from host-side collaborators.
 *
 * Slash commands are plain functions over this context, and the registry already
 * lives in the host process, so making a renderer able to run `/model` or
 * `/cost` is only a matter of building the context somewhere the filesystem, the
 * config and the loop are reachable. Twenty-four of its members are that.
 *
 * The other seven return nothing and mean nothing outside a view, so they go out
 * as `CommandEffect`s through `emit`. That is the whole reason `run-command` is
 * not a plain request/response: commands push these *while running*.
 *
 * Everything is read through a getter rather than captured. A model switch or a
 * `/clear` replaces the runtime and the session mid-command — `/model x` does
 * exactly that and then reads the new model back to print it.
 */
export interface HostCommandContextDeps {
  project: ProjectRuntime
  scope: SessionScope
  runtimeSlot: RuntimeSlot
  controller: SessionController
  getSession: () => SessionMeta
  getRecords: () => readonly SessionRecord[]
  /**
   * `/clear`. Owned by the caller because the transcript reset and the ledger
   * rebase that go with it are the host's bookkeeping, not this factory's.
   */
  startNewSession: () => Promise<void>
  emit: (effect: CommandEffect) => void
}

/**
 * Which side of the boundary satisfies each `CommandContext` member.
 *
 * Keyed rather than a list, so adding a member to `CommandContext` without
 * deciding where it runs fails the build *by name* — the same guard
 * `COMMAND_SCHEMAS` uses against `HostCommand`. `'host'` means this factory
 * implements it; anything else names the effect it turns into.
 */
export const COMMAND_CONTEXT_COVERAGE = {
  cwd: 'host',
  sessionId: 'host',
  writeLine: 'write-line',
  openCommandView: 'open-command-view',
  clearMessages: 'host',
  clearCachedSections: 'host',
  invalidateRecordsCache: 'host',
  repairRecords: 'host',
  resetCompactFailureCount: 'host',
  getUsage: 'host',
  getSessionMetricsSummary: 'host',
  getModel: 'host',
  setModel: 'host',
  getEffort: 'host',
  setEffort: 'host',
  openModelPicker: 'open-surface',
  openEffortPicker: 'open-surface',
  reloadAgentDefinitions: 'host',
  reloadSkills: 'host',
  getPermissionMode: 'host',
  enterPlanMode: 'host',
  readPlanFile: 'host',
  openPlanFile: 'host',
  submitQuery: 'host',
  runShellCommand: 'host',
  openProviderPanel: 'open-surface',
  openBackgroundTasks: 'open-surface',
  openResumePicker: 'open-surface',
  openRewindPanel: 'open-surface',
  listSubagentTasks: 'host',
  getSubagentDetails: 'host',
  cleanupSubagentWorktrees: 'host',
} as const satisfies Record<keyof CommandContext, 'host' | CommandEffect['kind']>

export function createHostCommandContext(deps: HostCommandContextDeps): CommandContext {
  const { project, scope, runtimeSlot, controller } = deps

  const modelSwitchDeps = (): ModelSwitchDeps => ({
    config: project.config,
    runtimeSlot,
    // Read fresh: `/provider` and `reload-settings` can add or remove keys
    // while this process is up.
    availableModelKeys: Object.keys(project.config.get().models),
    createRuntime: scope.createRuntime,
    getSession: deps.getSession,
    getRecords: deps.getRecords,
  })

  const currentModel = (): CommandModelInfo => ({
    key: runtimeSlot.current.modelKey,
    model: runtimeSlot.current.modelConfig.model,
    providerName: runtimeSlot.current.providerName,
  })

  const planFileDeps = { getPlanModeManager: () => runtimeSlot.current.planModeManager }

  return {
    cwd: project.cwd,
    get sessionId() {
      return deps.getSession().id
    },

    writeLine: (text) => deps.emit({ kind: 'write-line', text }),
    openCommandView: (view) => deps.emit({ kind: 'open-command-view', view }),
    openModelPicker: () => deps.emit({ kind: 'open-surface', surface: 'model-picker' }),
    openEffortPicker: () => deps.emit({ kind: 'open-surface', surface: 'effort-picker' }),
    openProviderPanel: () => deps.emit({ kind: 'open-surface', surface: 'provider-panel' }),
    openBackgroundTasks: () => deps.emit({ kind: 'open-surface', surface: 'background-tasks' }),
    openResumePicker: () => deps.emit({ kind: 'open-surface', surface: 'resume-picker' }),
    openRewindPanel: () => deps.emit({ kind: 'open-surface', surface: 'rewind-panel' }),

    clearMessages: () => deps.startNewSession(),
    clearCachedSections: () => runtimeSlot.current.loop.clearCachedSections(),
    invalidateRecordsCache: () => runtimeSlot.current.loop.invalidateRecordsCache(),

    repairRecords: async () => project.store.repairRecords(deps.getSession().id),
    resetCompactFailureCount: async () => {
      const sessionId = deps.getSession().id
      await project.store.setCompactFailureCount(sessionId, 0)
      resetAutoCompactFailureState(sessionId)
    },
    getSessionMetricsSummary: async () => project.store.loadMetricsSummary(deps.getSession().id),

    // Shared with the desktop status bar, which reads the same value off the
    // `snapshot` event. Both go through one function so `/cost` and the always-on
    // readout cannot print different numbers for the same turn.
    getUsage: (): CommandUsage => resolveUsageWithCost(
      controller.getSnapshot().usage.total,
      runtimeSlot.current.modelConfig.pricing,
    ),

    getModel: currentModel,
    // The full `/model` semantics, including the config write-back that the
    // `set-model` command deliberately omits.
    setModel: (input): SetModelResult => switchModel(modelSwitchDeps(), input),
    getEffort: () => runtimeSlot.getEffort(),
    setEffort: (level) => { runtimeSlot.setEffort(level) },

    reloadAgentDefinitions: () => project.reloadAgentDefinitions(),
    reloadSkills: () => project.reloadSkills(),

    getPermissionMode: () => scope.permissionGate.getMode(),
    // No snapshot push needed: `PermissionGate.setMode` notifies its own
    // listeners, and the host is subscribed to them.
    enterPlanMode: () => {
      applyPermissionModeTransition(scope.permissionGate, runtimeSlot.current.planModeManager, 'plan')
    },
    readPlanFile: () => readCurrentPlanFile(planFileDeps),
    openPlanFile: () => openPlanFileInEditor(planFileDeps),

    submitQuery: async (input, options) => {
      await controller.submit(input, buildRunOverrides({
        config: project.config,
        runtimeSlot,
        createActiveModelRuntime: project.createActiveModelRuntime,
      }, options))
    },
    runShellCommand: async (command) => {
      const result = await runtimeSlot.current.loop.runTool({
        id: randomUUID(),
        name: 'Bash',
        input: { command },
      })
      return {
        ok: result.ok,
        content: result.content,
        ...(result.errorCode ? { errorCode: result.errorCode } : {}),
      }
    },

    listSubagentTasks: () => listLatestSubagentTasks(project.store, deps.getSession().id),
    getSubagentDetails: (agentIdOrPrefix) =>
      getSubagentDetails(project.store, deps.getSession().id, agentIdOrPrefix),
    cleanupSubagentWorktrees: ({ apply }) =>
      cleanupSubagentWorktrees(project.store, deps.getSession().id, project.cwd, apply),
  }
}
