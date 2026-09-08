import type { EffortValue } from '../config/effort.js'
import type { ConfigService } from '../config/service.js'
import type { MyAgentSettings } from '../config/settings.js'
import { persistPermissionRule } from '../config/settings.js'
import type { ActiveModelRuntime } from '../harness/loop.js'
import { PermissionGate, permissionRulesFromSettings, type DenialStateStore } from '../harness/permissions.js'
import { SystemPromptSectionCache } from '../harness/sections.js'
import type { ImageAttachmentImporter, SessionRecord } from '../harness/types.js'
import type { AttachmentFactsResolver } from '../harness/turnImages.js'
import type { ContextManagementConfig } from '../prompts/budget.js'
import type { SessionMeta, SessionStore } from '../sessions/service.js'
import type { BackgroundTaskRegistry } from '../services/backgroundTasks/registry.js'
import type { SkillDefinition } from '../services/skills/skillsService.js'
import type { BaseAgentDefinition } from '../tools/AgentTool/AgentTool.js'
import { createUiBridges } from './bridges.js'
import { createRuntimeFactory } from './createRuntime.js'
import { reconcileOrphanedAgents } from './sessionSwitch.js'
import type { ToolRegistry } from './toolRegistry.js'
import type { SessionScope } from './types.js'

/**
 * The project-level collaborators a scope builds on. Every one of these is
 * shared across scopes on purpose — see `ProjectRuntime`.
 *
 * The four getters are read at scope-construction time *and* by the runtime
 * factory at every `createRuntime` call, so a reload is visible to scopes that
 * already exist.
 */
export interface SessionScopeDeps {
  cwd: string
  config: ConfigService
  store: SessionStore
  getSettings: () => MyAgentSettings
  getSkills: () => SkillDefinition[]
  getAgentDefinitions: () => BaseAgentDefinition[]
  getProjectContext: () => string
  toolRegistry: ToolRegistry
  backgroundTasks: BackgroundTaskRegistry
  contextManagement: Partial<ContextManagementConfig> | undefined
  isGitRepo: boolean
  /** Already clamped to the default model; `RuntimeSlot` re-clamps per runtime. */
  initialEffort: EffortValue
  createActiveModelRuntime: (modelKey: string) => ActiveModelRuntime
  /** The project's attachment store — one per project, shared by its scopes. */
  imageAttachments?: ImageAttachmentImporter
  /** The same store seen as the request path's facts resolver (S15). */
  attachmentFacts?: AttachmentFactsResolver
}

/**
 * Builds one independent session scope.
 *
 * This is the assembly that used to sit inline in `bootstrap()` and run exactly
 * once per process. Nothing about the construction changed — same objects, same
 * arguments, same order — only how many times it may happen.
 */
export async function createSessionScope(
  deps: SessionScopeDeps,
  session: SessionMeta,
): Promise<SessionScope> {
  const settings = deps.getSettings()
  const bridges = createUiBridges()

  // The gate and every subagent under it share one denial-state store, but the
  // session it targets changes with `/clear` and `/resume`. Read the id at call
  // time so counters are never written back to whichever session this scope
  // opened with.
  let activeSessionId = session.id
  const denialStateStore: DenialStateStore = {
    getDenialState: async () => deps.store.getDenialState(activeSessionId),
    setDenialState: async (state) => deps.store.setDenialState(activeSessionId, state),
  }

  const permissionGate = new PermissionGate(
    bridges.prompt.prompt,
    permissionRulesFromSettings(settings.permissions),
    {
      denialStateStore,
      cwd: deps.cwd,
      ...(settings.permissions?.additionalDirectories
        ? { additionalDirectories: settings.permissions.additionalDirectories }
        : {}),
      mode: settings.permissions?.mode ?? 'default',
      persistRule: (rule) => persistPermissionRule(deps.cwd, rule),
    },
  )

  const promptSections = new SystemPromptSectionCache()

  // Installed by whoever builds the controller on this scope; until then the
  // write tools run with nothing tracking them, which is what a scope without a
  // UI wants anyway.
  let trackFileEdit: ((filePath: string) => Promise<void>) | undefined

  const createRuntime = createRuntimeFactory({
    cwd: deps.cwd,
    config: deps.config,
    store: deps.store,
    getSettings: deps.getSettings,
    getSkills: deps.getSkills,
    getAgentDefinitions: deps.getAgentDefinitions,
    getProjectContext: deps.getProjectContext,
    toolRegistry: deps.toolRegistry,
    promptSections,
    permissionGate,
    denialStateStore,
    backgroundTasks: deps.backgroundTasks,
    bridges,
    contextManagement: deps.contextManagement,
    isGitRepo: deps.isGitRepo,
    initialEffort: deps.initialEffort,
    createActiveModelRuntime: deps.createActiveModelRuntime,
    // Read at call time, so a tracker installed after the first runtime was
    // built still reaches it.
    trackFileEdit: (filePath) => trackFileEdit?.(filePath) ?? Promise.resolve(),
    ...(deps.imageAttachments ? { imageAttachments: deps.imageAttachments } : {}),
    ...(deps.attachmentFacts ? { attachmentFacts: deps.attachmentFacts } : {}),
    onActiveSessionChange: (nextSessionId) => {
      if (nextSessionId === activeSessionId) return
      activeSessionId = nextSessionId
      permissionGate.resetDenialState()
    },
  })

  const load = await deps.store.loadRecordsWithDiagnostics(session.id)
  const records = load.records
  // Already-registered tasks mean this session is live in this process, so
  // restoring it again would double-register every one of them. Same guard as
  // `switchToExistingSession`; it can only fire for a scope opened onto a
  // session another scope already has.
  const alreadyRegistered = deps.backgroundTasks.getSnapshot(session.id).length > 0
  const orphanedAgentIds = alreadyRegistered
    ? []
    : await deps.backgroundTasks.restoreSession(session.id, records)
  for (const record of reconcileOrphanedAgents(records, orphanedAgentIds)) {
    await deps.store.appendRecord(session.id, record)
    records.push(record)
  }

  return {
    session,
    bridges,
    permissionGate,
    promptSections,
    createRuntime,
    setFileEditTracker: (track) => {
      trackFileEdit = track
    },
    existingRecords: records,
    hasRecoverableInterruption: hasRecoverableInterruption(records),
    diagnostics: load.diagnostics,
    dispose: () => {
      // Parked permission requests are the only work the bridges themselves
      // hold; the other three forward straight to whatever installed a handler,
      // and that installer settles its own in-flight promises. What is left to
      // do here is put all four back to their pre-mount fallbacks so a late
      // call answers instead of hanging.
      //
      // The fallbacks stay asymmetric on purpose (deny / reject / approve /
      // reject) — see `bridges.ts` and `UI_REQUEST_FALLBACKS`.
      bridges.prompt.clearPrompt()
      bridges.prompt.drainPending()
      bridges.askUserQuestion.setOpen(async () => ({
        kind: 'rejected',
        feedback: 'AskUserQuestion UI is not mounted.',
      }))
      bridges.enterPlan.setOpen(async () => true)
      bridges.exitPlan.setOpen(async () => ({ kind: 'reject', feedback: '' }))
      bridges.record.setHandler(() => {})
      bridges.record.setProgressHandler(() => {})
      bridges.record.setStreamEventHandler(() => {})
      trackFileEdit = undefined
    },
  }
}

/** True when the last turn was interrupted and can still be resumed. */
export function hasRecoverableInterruption(records: readonly SessionRecord[]): boolean {
  return [...records]
    .reverse()
    .some((record) => record.type === 'turn_interruption' && record.recoverable && !record.consumedAt)
}
