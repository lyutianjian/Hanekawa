import { createProvider, resolveImageCapability } from '../config/providers.js'
import type { ConfigService, ModelConfig, ThinkingConfig } from '../config/service.js'
import type { EffortLevel, EffortValue } from '../config/effort.js'
import type { RoutingRole } from '../config/routing.js'
import { validateSettings, type MyAgentSettings } from '../config/settings.js'
import { AgentLoop, type ActiveModelRuntime } from '../harness/loop.js'
import { ContextBuilder } from '../harness/contextBuilder.js'
import { PlanModeManager } from '../harness/planModeManager.js'
import { ToolRunner } from '../harness/toolRunner.js'
import type { SystemPromptSectionCache } from '../harness/sections.js'
import type { DenialStateStore, PermissionGate } from '../harness/permissions.js'
import type { AttachmentBytesLoader, ImageAttachmentImporter, SessionRecord } from '../harness/types.js'
import type { AttachmentFactsResolver } from '../harness/turnImages.js'
import { MODEL_CONTEXT_WINDOW_DEFAULT } from '../prompts/budget.js'
import type { ContextManagementConfig } from '../prompts/budget.js'
import { JsonlRecordStream } from '../sessions/recordStream.js'
import type { SessionMeta, SessionStore } from '../sessions/service.js'
import { createAgentTool, prepareForkPreloadRecords } from '../tools/AgentTool/AgentTool.js'
import type { BaseAgentDefinition } from '../tools/AgentTool/AgentTool.js'
import { restoreTaskStateFromRecords } from '../tools/taskState.js'
import type { SkillDefinition } from '../services/skills/skillsService.js'
import type { BackgroundTaskRegistry } from '../services/backgroundTasks/registry.js'
import type { UiBridges } from './bridges.js'
import { RuntimeStartupError } from './errors.js'
import type { ToolRegistry } from './toolRegistry.js'
import type { AgentSession } from './types.js'

function createModelProvider(modelKey: string, modelConfig: ModelConfig) {
  const validation = validateSettings({ models: { [modelKey]: modelConfig } })
  if (!validation.valid) throw new RuntimeStartupError('unknown_model', validation.errors.join('\n'))
  let provider
  try {
    provider = createProvider(modelConfig)
  } catch (error) {
    // SDKs can reject local configuration (for example a missing API key)
    // during construction, before the user has had a chance to open settings.
    throw new RuntimeStartupError(
      'provider_creation_failed',
      `Could not initialize provider "${modelConfig.provider}": ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (!provider) {
    throw new RuntimeStartupError('provider_creation_failed', `Unsupported or missing provider: ${modelConfig.provider ?? '(none)'}`)
  }
  return provider
}

/**
 * Resolves a model key into the provider/model pair the loop runs on.
 * Re-reads `config` on every call, so `/provider` edits take effect without
 * restarting.
 */
export function createActiveModelRuntimeFactory(
  config: ConfigService,
): (modelKey: string) => ActiveModelRuntime {
  return (modelKey: string): ActiveModelRuntime => {
    const targetModelConfig = config.getModel(modelKey)
    if (!targetModelConfig) {
      throw new RuntimeStartupError('unknown_model', `Unknown model: ${modelKey}`)
    }
    const targetProvider = createModelProvider(modelKey, targetModelConfig)
    return {
      provider: targetProvider,
      model: targetModelConfig.model,
      modelKey,
      contextWindow: targetModelConfig.contextWindow ?? MODEL_CONTEXT_WINDOW_DEFAULT,
      providerName: targetProvider.name,
      promptCacheRetention: targetModelConfig.promptCacheRetention,
      supportsImageInput: resolveImageCapability(targetModelConfig),
    }
  }
}

export interface CreateRuntimeDeps {
  cwd: string
  config: ConfigService
  store: SessionStore
  /**
   * All four are read at call time rather than captured, so a reload changes
   * what the *next* runtime is built from. `/agents reload` only ever worked
   * because it was already a getter; settings and skills were captured by value
   * and silently stayed at their startup contents for the life of the process.
   */
  getSettings: () => MyAgentSettings
  getSkills: () => SkillDefinition[]
  getAgentDefinitions: () => BaseAgentDefinition[]
  /**
   * `AGENTS.md` / `CLAUDE.md` and the rules files under them, already merged.
   * Captured per runtime like the settings above, so an edit reaches a session
   * on the next rebuild — see `reloadSettings`'s `needsRuntimeRebuild`.
   */
  getProjectContext: () => string
  toolRegistry: ToolRegistry
  promptSections: SystemPromptSectionCache
  permissionGate: PermissionGate
  denialStateStore: DenialStateStore
  backgroundTasks: BackgroundTaskRegistry
  bridges: UiBridges
  contextManagement: Partial<ContextManagementConfig> | undefined
  isGitRepo: boolean
  initialEffort: EffortValue
  createActiveModelRuntime: (modelKey: string) => ActiveModelRuntime
  /**
   * Called by every write tool before they write, so the session's file history
   * can back the file up. Subagents inherit it through their forked context.
   */
  trackFileEdit?: (filePath: string) => Promise<void>
  /**
   * The project's attachment store, shared by `@`-mentioned project images
   * (input preparation) and the Read tool's image branch (toolContext). One
   * service per project (see `bootstrap`); the loop keeps its own reference,
   * and the Agent tool wraps it per subagent run so the child's images are
   * owned by this session rather than by the agent id (S23).
   */
  imageAttachments?: ImageAttachmentImporter
  /**
   * The project's attachment store as the request path's facts resolver —
   * current-input availability checks and historical-image placeholders (S15).
   */
  attachmentFacts?: AttachmentFactsResolver
  /**
   * The project's attachment store as the request path's send-byte loader —
   * the loop loads final-send image bytes through it (S17).
   */
  attachmentBytes?: AttachmentBytesLoader
  /**
   * Notified whenever a runtime is built for a different session than the last
   * one. `bootstrap` uses it to retarget session-scoped state (denial counters)
   * that the gate holds across runtimes.
   */
  onActiveSessionChange?: (sessionId: string) => void
}

export type CreateRuntime = (
  modelKey: string,
  runtimeSession: SessionMeta,
  runtimeRecords?: readonly SessionRecord[],
) => AgentSession

/**
 * Builds the factory that assembles one complete agent runtime. Every model
 * switch, `/clear`, and resume calls it again and disposes the previous
 * result.
 */
export function createRuntimeFactory(deps: CreateRuntimeDeps): CreateRuntime {
  const {
    cwd,
    config,
    store,
    getSettings,
    getSkills,
    getAgentDefinitions,
    getProjectContext,
    toolRegistry,
    promptSections,
    permissionGate,
    denialStateStore,
    backgroundTasks,
    bridges,
    contextManagement,
    isGitRepo,
    initialEffort,
    createActiveModelRuntime,
    trackFileEdit,
    imageAttachments,
    attachmentFacts,
    attachmentBytes,
    onActiveSessionChange,
  } = deps

  const createRoutedRuntime = (
    role: RoutingRole,
    currentModelKey: string,
  ): ActiveModelRuntime | undefined => {
    const routedModelKey = config.resolveModelKeyFor(role, { currentModelKey })
    return routedModelKey ? createActiveModelRuntime(routedModelKey) : undefined
  }

  return (modelKey, runtimeSession, runtimeRecords = []) => {
    const targetModelConfig = config.getModel(modelKey)
    if (!targetModelConfig) {
      throw new RuntimeStartupError('unknown_model', `Unknown model: ${modelKey}`)
    }

    const targetProvider = createModelProvider(modelKey, targetModelConfig)

    // Past the last throwing validation, so a rejected model key never
    // retargets session-scoped state.
    onActiveSessionChange?.(runtimeSession.id)

    const currentFallbackModelKey = config.resolveModelReference(config.get().fallbackModel)
    const fallbackModel = currentFallbackModelKey && currentFallbackModelKey !== modelKey
      ? createActiveModelRuntime(currentFallbackModelKey)
      : undefined

    const currentCompactModelKey = config.resolveModelReference(config.get().compactModel)
    const compactModel = currentCompactModelKey
      ? createActiveModelRuntime(currentCompactModelKey)
      : createRoutedRuntime({ kind: 'compact' }, modelKey)
    const planModel = createRoutedRuntime({ kind: 'plan' }, modelKey)

    const recordStream = new JsonlRecordStream(store, runtimeSession.id)
    let loop: AgentLoop | undefined
    const planModeManager = new PlanModeManager({
      cwd,
      sessionMeta: runtimeSession,
      store,
      gate: permissionGate,
      appendRecord: async (record) => {
        await recordStream.append(record)
        loop?.noteRecordAppended(record)
        bridges.record.onRecord(record)
      },
      loadRecords: async () => recordStream.load(),
      openEnterPrompt: bridges.enterPlan.open,
      openExitDialog: bridges.exitPlan.open,
    })
    const planSlugProvider = () => planModeManager.getSlug()
    permissionGate.setPlanSlugProvider(planSlugProvider)

    // `thinking: false` in settings means "send no thinking parameter"; unset is
    // the adaptive default. Read per runtime, so a settings reload followed by a
    // rebuild is all it takes for the switch to reach a session.
    const thinking: ThinkingConfig = getSettings().thinking === false
      ? { type: 'disabled' }
      : { type: 'adaptive' }

    const runtimeTools = toolRegistry.buildRuntimeTools()
    runtimeTools.push(createAgentTool({
      provider: targetProvider,
      model: targetModelConfig.model,
      modelKey,
      contextWindow: targetModelConfig.contextWindow ?? MODEL_CONTEXT_WINDOW_DEFAULT,
      providerName: targetProvider.name,
      promptCacheRetention: targetModelConfig.promptCacheRetention,
      supportsImageInput: resolveImageCapability(targetModelConfig),
      fallbackModel,
      tools: () => runtimeTools,
      permissionPrompt: bridges.prompt.prompt,
      permissionMode: () => permissionGate.getMode(),
      getConfigRules: () => permissionGate.getConfigRules(),
      getSessionRules: () => permissionGate.getSessionRules(),
      getSessionRuleStore: () => permissionGate.getSessionRuleStore(),
      getAdditionalDirectories: () => permissionGate.getAdditionalDirectories(),
      denialStateStore,
      cwd,
      system: config.get().agent.system,
      projectContext: getProjectContext(),
      skills: getSkills(),
      agentDefinitions: getAgentDefinitions(),
      loadParentRecords: async () => prepareForkPreloadRecords(await recordStream.load()),
      contextManagement,
      isGitRepo,
      hooks: getSettings().hooks,
      cacheRuntime: { settings: getSettings(), env: process.env },
      // Subagents follow the same switch as the main loop.
      thinking,
      compactModel,
      onSubagentProgress: (event) => bridges.record.onProgress(event),
      resolveSubagentModel: (subagentType, requestedModelKey) => requestedModelKey
        ? createActiveModelRuntime(requestedModelKey)
        : createRoutedRuntime(
          { kind: 'subagent', type: subagentType },
          modelKey,
        ),
      getCompactFailureCount: async () => (await store.load(runtimeSession.id))?.compactFailureCount ?? 0,
      setCompactFailureCount: async (count) => store.setCompactFailureCount(runtimeSession.id, count),
      agentTimeoutMs: config.get().agent.agentTimeoutMs,
      backgroundTasks,
      // The same three handles the main loop gets. The Agent tool re-owns the
      // importer per run so a subagent's images land in *this* session's tree
      // (S23); the two read-only ones pass straight through, since they only
      // resolve refs that are already registered.
      ...(imageAttachments ? { imageAttachments } : {}),
      ...(attachmentFacts ? { attachmentFacts } : {}),
      ...(attachmentBytes ? { attachmentBytes } : {}),
    }))

    toolRegistry.register(runtimeTools)
    const runtimeToolRunner = new ToolRunner(runtimeTools, permissionGate, {
      onRecord: async (record) => {
        await recordStream.append(record)
        bridges.record.onRecord(record)
      },
      onProgress: (event) => {
        bridges.record.onProgress(event)
      },
    }, {
      preToolUse: getSettings().hooks?.preToolUse,
    })

    loop = new AgentLoop({
      provider: targetProvider,
      model: targetModelConfig.model,
      modelKey,
      contextWindow: targetModelConfig.contextWindow ?? MODEL_CONTEXT_WINDOW_DEFAULT,
      tools: runtimeTools,
      contextBuilder: new ContextBuilder(undefined, contextManagement, promptSections),
      toolRunner: runtimeToolRunner,
      toolContext: {
        cwd,
        sessionId: runtimeSession.id,
        readFiles: new Set(),
        readFileState: new Map(),
        invokedSkills: new Map(),
        taskState: new Map(restoreTaskStateFromRecords(runtimeRecords)),
        getPermissionMode: () => permissionGate.getMode(),
        setPermissionMode: (mode) => permissionGate.setMode(mode),
        exitPlanMode: () => permissionGate.exitPlanMode(),
        planModeBridge: planModeManager.buildBridge(),
        askUserQuestionBridge: bridges.askUserQuestion,
        ...(trackFileEdit ? { trackFileEdit } : {}),
        ...(imageAttachments ? { imageAttachments } : {}),
      },
      system: config.get().agent.system,
      projectContext: getProjectContext(),
      skills: getSkills(),
      promptCacheRetention: targetModelConfig.promptCacheRetention,
      supportsImageInput: resolveImageCapability(targetModelConfig),
      contextManagement,
      isGitRepo,
      hooks: getSettings().hooks,
      cacheRuntime: { settings: getSettings(), env: process.env },
      thinking,
      effort: typeof initialEffort === 'string' ? initialEffort as EffortLevel : undefined,
      permissionMode: () => permissionGate.getMode(),
      planModeManager,
      fallbackModel,
      compactModel,
      planModel,
      getCompactFailureCount: async () => (await store.load(runtimeSession.id))?.compactFailureCount ?? 0,
      setCompactFailureCount: async (count) => store.setCompactFailureCount(runtimeSession.id, count),
      recordStream,
      onRecord: (record) => bridges.record.onRecord(record),
      onStreamEvent: (event) => bridges.record.onStreamEvent(event),
      onRequestUsage: (usage, anchorRecordId) => bridges.record.onRequestUsage(usage, anchorRecordId),
      ...(imageAttachments ? { imageAttachments } : {}),
      ...(attachmentFacts ? { attachmentFacts } : {}),
      ...(attachmentBytes ? { attachmentBytes } : {}),
    })

    const activeLoop = loop
    return {
      loop: activeLoop,
      planModeManager,
      modelKey,
      modelConfig: targetModelConfig,
      providerName: targetProvider.name,
      run: (input, signal, messageId, overrides) => activeLoop.run(input, signal, messageId, overrides),
      dispose: () => {
        toolRegistry.unregister(runtimeTools)
        permissionGate.clearPlanSlugProvider(planSlugProvider)
      },
    }
  }
}
