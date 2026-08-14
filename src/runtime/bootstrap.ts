import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { ConfigService } from '../config/service.js'
import {
  loadMergedSettings,
  persistPermissionRule,
  validateSettings,
} from '../config/settings.js'
import { clampEffort } from '../config/effort.js'
import { PermissionGate, permissionRulesFromSettings, type DenialStateStore } from '../harness/permissions.js'
import { setCacheBreakDiagnosticsRoot } from '../harness/cacheBreakDetection.js'
import { SystemPromptSectionCache } from '../harness/sections.js'
import type { SessionRecord } from '../harness/types.js'
import { getAllTools } from '../tools/index.js'
import { BUILT_IN_AGENT_DEFINITIONS } from '../tools/agentTool.js'
import { SkillsService } from '../services/skills/skillsService.js'
import { AgentDefinitionLoader } from '../services/agents/agentDefinitionLoader.js'
import { BackgroundTaskRegistry } from '../services/backgroundTasks/registry.js'
import { registerBuiltinCommands } from '../commands/index.js'
import { registerSkillCommands } from '../commands/skills.js'
import { createUiBridges } from './bridges.js'
import { createActiveModelRuntimeFactory, createRuntimeFactory } from './createRuntime.js'
import { RuntimeStartupError } from './errors.js'
import { connectMcpServers } from './mcp.js'
import { ToolRegistry } from './toolRegistry.js'
import type { BootstrapOptions, RuntimeHost } from './types.js'

function mergeAgentDefinitions<T extends { type: string }>(base: readonly T[], overrides: readonly T[]): T[] {
  const merged = new Map<string, T>()
  for (const definition of base) merged.set(definition.type, definition)
  for (const definition of overrides) merged.set(definition.type, definition)
  return [...merged.values()]
}

/**
 * Assembles everything needed to run an agent in `cwd`, with no terminal or
 * React dependency: settings, config, tools, skills, agent definitions, MCP
 * servers, the permission gate, and the runtime factory.
 *
 * Configuration problems throw {@link RuntimeStartupError} instead of exiting,
 * so the host decides how to report them. MCP failures never throw — they are
 * reported in `mcp.failed`.
 */
export async function bootstrap(options: BootstrapOptions): Promise<RuntimeHost> {
  const { cwd, store, session, confirmMcpTrust } = options

  setCacheBreakDiagnosticsRoot(cwd)

  const backgroundTasks = new BackgroundTaskRegistry(
    (sessionId, record) => store.appendRecord(sessionId, record),
  )

  const settings = await loadMergedSettings(cwd)
  const configuredEffortLevel = settings.effortLevel ?? 'high'
  const config = new ConfigService(cwd)
  await config.load(settings)
  const settingsValidation = validateSettings(settings)
  if (!settingsValidation.valid) {
    throw new RuntimeStartupError(
      'invalid_settings',
      `Invalid settings:\n${settingsValidation.errors.map((error) => `- ${error}`).join('\n')}`,
    )
  }

  const initialModelKey = config.resolveModelKeyFor(
    { kind: 'main' },
    { currentModelKey: config.get().defaultModel },
  )
  if (!initialModelKey) {
    throw new RuntimeStartupError('no_default_model', 'No default model configured.')
  }
  const modelConfig = config.getModel(initialModelKey)
  if (!modelConfig) {
    throw new RuntimeStartupError(
      'unknown_initial_model',
      `Initial model could not be resolved: ${initialModelKey}`,
    )
  }
  const clampedInitialEffort = clampEffort(configuredEffortLevel, modelConfig.maxEffort)
  const fallbackModelKey = config.resolveModelReference(config.get().fallbackModel)
  if (fallbackModelKey && !config.getModel(fallbackModelKey)) {
    throw new RuntimeStartupError(
      'unknown_fallback_model',
      `Unknown fallback model configured: ${config.get().fallbackModel}`,
    )
  }
  const compactModelKey = config.resolveModelReference(config.get().compactModel)
  if (compactModelKey && !config.getModel(compactModelKey)) {
    throw new RuntimeStartupError(
      'unknown_compact_model',
      `Unknown compact model configured: ${config.get().compactModel}`,
    )
  }

  const toolRegistry = new ToolRegistry(await getAllTools(backgroundTasks))
  const skills = await new SkillsService(cwd).list()
  const agentLoader = new AgentDefinitionLoader(cwd)
  let customAgentDefinitions = await agentLoader.list()
  let agentDefinitions = mergeAgentDefinitions([...BUILT_IN_AGENT_DEFINITIONS], customAgentDefinitions)
  const reloadAgentDefinitions = async (): Promise<number> => {
    agentLoader.invalidate()
    customAgentDefinitions = await agentLoader.list()
    agentDefinitions = mergeAgentDefinitions([...BUILT_IN_AGENT_DEFINITIONS], customAgentDefinitions)
    return customAgentDefinitions.length
  }
  const promptSections = new SystemPromptSectionCache()

  // Fail-open: a server that fails to connect is reported but does not block
  // startup. Trust is confirmed through the host, before it owns stdin.
  const mcp = await connectMcpServers({
    cwd,
    settings,
    registry: toolRegistry,
    confirmTrust: confirmMcpTrust,
    onConnectFailure: async (name, error) => {
      await store.appendMetric(session.id, {
        event: 'mcp_connect_failed',
        server: name,
        error,
      })
    },
  })

  registerBuiltinCommands()
  await registerSkillCommands(cwd)

  const bridges = createUiBridges()
  // The gate and every subagent share one denial-state store, but the session
  // it targets changes with `/clear` and `/resume`. Read the id at call time so
  // counters are never written back to whichever session was active at startup.
  let activeSessionId = session.id
  const denialStateStore: DenialStateStore = {
    getDenialState: async () => store.getDenialState(activeSessionId),
    setDenialState: async (state) => store.setDenialState(activeSessionId, state),
  }
  const permissionGate = new PermissionGate(bridges.prompt.prompt, permissionRulesFromSettings(settings.permissions), {
    denialStateStore,
    cwd,
    mode: settings.permissions?.mode ?? 'default',
    persistRule: (rule) => persistPermissionRule(cwd, rule),
  })

  const contextManagement = config.get().agent.contextManagement
  const isGitRepo = existsSync(join(cwd, '.git'))

  const createActiveModelRuntime = createActiveModelRuntimeFactory(config)
  const createRuntime = createRuntimeFactory({
    cwd,
    config,
    store,
    settings,
    skills,
    getAgentDefinitions: () => agentDefinitions,
    toolRegistry,
    promptSections,
    permissionGate,
    denialStateStore,
    backgroundTasks,
    bridges,
    contextManagement,
    isGitRepo,
    initialEffort: clampedInitialEffort,
    createActiveModelRuntime,
    onActiveSessionChange: (nextSessionId) => {
      if (nextSessionId === activeSessionId) return
      activeSessionId = nextSessionId
      permissionGate.resetDenialState()
    },
  })

  const existingLoad = await store.loadRecordsWithDiagnostics(session.id)
  const orphanedAgentIds = new Set(await backgroundTasks.restoreSession(session.id, existingLoad.records))
  if (orphanedAgentIds.size > 0) {
    const latestAgentTasks = new Map<string, Extract<SessionRecord, { type: 'subagent_task' }>>()
    for (const record of existingLoad.records) {
      if (record.type === 'subagent_task') latestAgentTasks.set(record.agentId, record)
    }
    for (const agentId of orphanedAgentIds) {
      const previous = latestAgentTasks.get(agentId)
      if (!previous || previous.status !== 'running') continue
      const interrupted: Extract<SessionRecord, { type: 'subagent_task' }> = {
        ...previous,
        id: randomUUID(),
        status: 'interrupted',
        error: 'Background agent was not present when the session resumed',
        createdAt: new Date().toISOString(),
      }
      await store.appendRecord(session.id, interrupted)
      existingLoad.records.push(interrupted)
    }
  }

  return {
    cwd,
    config,
    store,
    session,
    permissionGate,
    backgroundTasks,
    bridges,
    initialModelKey,
    initialEffort: typeof clampedInitialEffort === 'string' ? clampedInitialEffort : undefined,
    configuredEffortLevel,
    existingRecords: existingLoad.records,
    hasRecoverableInterruption: hasRecoverableInterruption(existingLoad.records),
    diagnostics: existingLoad.diagnostics,
    mcp: mcp.status,
    createRuntime,
    createActiveModelRuntime,
    reloadAgentDefinitions,
    shutdown: async (reason: string) => {
      // Swallow errors so a misbehaving server cannot prevent a clean exit.
      await backgroundTasks.stopAll(undefined, reason)
      await Promise.allSettled(mcp.clients.map((client) => client.close()))
    },
  }
}

function hasRecoverableInterruption(records: readonly SessionRecord[]): boolean {
  return [...records]
    .reverse()
    .some((record) => record.type === 'turn_interruption' && record.recoverable && !record.consumedAt)
}
