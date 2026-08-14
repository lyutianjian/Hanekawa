import { createProvider } from '../config/providers.js'
import type { ConfigService } from '../config/service.js'
import type { EffortLevel, EffortValue } from '../config/effort.js'
import type { RoutingRole } from '../config/routing.js'
import type { MyAgentSettings } from '../config/settings.js'
import { AgentLoop, type ActiveModelRuntime } from '../harness/loop.js'
import { ContextBuilder } from '../harness/contextBuilder.js'
import { PlanModeManager } from '../harness/planModeManager.js'
import { ToolRunner } from '../harness/toolRunner.js'
import type { SystemPromptSectionCache } from '../harness/sections.js'
import type { DenialStateStore, PermissionGate } from '../harness/permissions.js'
import type { SessionRecord } from '../harness/types.js'
import { MODEL_CONTEXT_WINDOW_DEFAULT } from '../prompts/modelCapabilities.js'
import type { ContextManagementConfig } from '../prompts/budget.js'
import { JsonlRecordStream } from '../sessions/recordStream.js'
import type { SessionMeta, SessionStore } from '../sessions/service.js'
import { createAgentTool, prepareForkPreloadRecords } from '../tools/agentTool.js'
import type { BaseAgentDefinition } from '../tools/agentTool.js'
import { restoreTaskStateFromRecords } from '../tools/taskState.js'
import type { SkillDefinition } from '../services/skills/skillsService.js'
import type { BackgroundTaskRegistry } from '../services/backgroundTasks/registry.js'
import type { UiBridges } from './bridges.js'
import { RuntimeStartupError } from './errors.js'
import type { ToolRegistry } from './toolRegistry.js'
import type { AgentSession } from './types.js'

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
    const targetProvider = createProvider(targetModelConfig)
    if (!targetProvider) {
      throw new RuntimeStartupError(
        'provider_creation_failed',
        `Failed to create provider for: ${targetModelConfig.provider}`,
      )
    }
    return {
      provider: targetProvider,
      model: targetModelConfig.model,
      modelKey,
      contextWindow: targetModelConfig.contextWindow ?? MODEL_CONTEXT_WINDOW_DEFAULT,
      providerName: targetProvider.name,
      promptCacheRetention: targetModelConfig.promptCacheRetention,
    }
  }
}

export interface CreateRuntimeDeps {
  cwd: string
  config: ConfigService
  store: SessionStore
  settings: MyAgentSettings
  skills: SkillDefinition[]
  /** Read at call time: `/agents` reload replaces the array. */
  getAgentDefinitions: () => BaseAgentDefinition[]
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
    settings,
    skills,
    getAgentDefinitions,
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

    const targetProvider = createProvider(targetModelConfig)
    if (!targetProvider) {
      throw new RuntimeStartupError(
        'provider_creation_failed',
        `Failed to create provider for: ${targetModelConfig.provider}`,
      )
    }

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
    permissionGate.setPlanSlugProvider(() => planModeManager.getSlug())

    const runtimeTools = toolRegistry.buildRuntimeTools()
    runtimeTools.push(createAgentTool({
      provider: targetProvider,
      model: targetModelConfig.model,
      modelKey,
      contextWindow: targetModelConfig.contextWindow ?? MODEL_CONTEXT_WINDOW_DEFAULT,
      providerName: targetProvider.name,
      promptCacheRetention: targetModelConfig.promptCacheRetention,
      fallbackModel,
      tools: () => runtimeTools,
      permissionPrompt: bridges.prompt.prompt,
      permissionMode: () => permissionGate.getMode(),
      getConfigRules: () => permissionGate.getConfigRules(),
      getSessionRules: () => permissionGate.getSessionRules(),
      getSessionRuleStore: () => permissionGate.getSessionRuleStore(),
      denialStateStore,
      cwd,
      system: config.get().agent.system,
      skills,
      agentDefinitions: getAgentDefinitions(),
      loadParentRecords: async () => prepareForkPreloadRecords(await recordStream.load()),
      contextManagement,
      isGitRepo,
      hooks: settings.hooks,
      cacheRuntime: { settings, env: process.env },
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
      preToolUse: settings.hooks?.preToolUse,
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
      },
      system: config.get().agent.system,
      skills,
      promptCacheRetention: targetModelConfig.promptCacheRetention,
      contextManagement,
      isGitRepo,
      hooks: settings.hooks,
      cacheRuntime: { settings, env: process.env },
      thinking: { type: 'adaptive' },
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
      },
    }
  }
}
