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
import type { RuntimeDiagnostic } from '../harness/diagnostics.js'
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

  // Mutable so `reloadSettings()` can replace it; `createRuntime` reads it
  // through a getter, so the next runtime built picks up the new contents.
  let settings = await loadMergedSettings(cwd)
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
    // `resolveModelKeyFor` returns undefined both when nothing is configured and
    // when what *is* configured names a model that does not exist. Saying "none
    // configured" for a typo sent people looking in the wrong place.
    const configured = configuredModelName(config.get().defaultModel)
    throw new RuntimeStartupError(
      'no_default_model',
      configured
        ? `Default model could not be resolved: ${configured}. Check "models" in your config.`
        : 'No default model configured.',
    )
  }
  const modelConfig = config.getModel(initialModelKey)!
  const modelDiagnostics = checkOptionalModelReferences(config)
  const clampedInitialEffort = clampEffort(configuredEffortLevel, modelConfig.maxEffort)

  const toolRegistry = new ToolRegistry(await getAllTools(backgroundTasks))
  // Constructed fresh on every read: the service caches, and a reload exists
  // precisely to see files that changed since startup.
  let skills = await new SkillsService(cwd).list()
  const agentLoader = new AgentDefinitionLoader(cwd)
  let customAgentDefinitions = await agentLoader.list()
  let agentDefinitions = mergeAgentDefinitions([...BUILT_IN_AGENT_DEFINITIONS], customAgentDefinitions)
  const reloadAgentDefinitions = async (): Promise<number> => {
    agentLoader.invalidate()
    customAgentDefinitions = await agentLoader.list()
    agentDefinitions = mergeAgentDefinitions([...BUILT_IN_AGENT_DEFINITIONS], customAgentDefinitions)
    return customAgentDefinitions.length
  }

  /**
   * Re-reads `.myagent/skills/` and re-registers the slash commands they define.
   *
   * The prompt side needs no help: `ContextBuilder` fingerprints its
   * `# Available skills` section and drops the cached copy when it changes.
   */
  const reloadSkills = async (): Promise<number> => {
    skills = await new SkillsService(cwd).list()
    await registerSkillCommands(cwd)
    return skills.length
  }

  /**
   * Re-reads the settings layers.
   *
   * Only the parts that are read live take effect immediately — permission
   * rules and the config layer. Hooks and the cache-break `cacheRuntime` are
   * captured when a runtime is constructed, so the caller has to rebuild the
   * runtime for those; `needsRuntimeRebuild` says so rather than leaving the
   * caller to guess.
   */
  const reloadSettings = async (): Promise<{ needsRuntimeRebuild: boolean }> => {
    const next = await loadMergedSettings(cwd)
    const validation = validateSettings(next)
    if (!validation.valid) {
      throw new RuntimeStartupError(
        'invalid_settings',
        `Invalid settings:\n${validation.errors.map((error) => `- ${error}`).join('\n')}`,
      )
    }

    const hooksChanged = JSON.stringify(next.hooks) !== JSON.stringify(settings.hooks)
    settings = next
    await config.load(settings)
    permissionGate.setConfigRules(permissionRulesFromSettings(settings.permissions))
    return { needsRuntimeRebuild: hooksChanged }
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
    getSettings: () => settings,
    getSkills: () => skills,
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
    diagnostics: [...modelDiagnostics, ...existingLoad.diagnostics],
    mcp: mcp.status,
    createRuntime,
    createActiveModelRuntime,
    reloadAgentDefinitions,
    reloadSkills,
    reloadSettings,
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

/**
 * The configured name, or undefined when the setting means "unset".
 *
 * `inherit` is a legitimate value that resolves to nothing on purpose, so it is
 * not a misconfiguration.
 */
function configuredModelName(reference: string | undefined): string | undefined {
  const trimmed = reference?.trim()
  if (!trimmed || trimmed.toLowerCase() === 'inherit') return undefined
  return trimmed
}

/**
 * Warns about `fallbackModel` / `compactModel` naming something that does not
 * exist.
 *
 * `resolveModelReference` only ever returns a key `resolveModel` already
 * accepted, so the old `config.getModel(resolved)` guards here could never
 * fire. What they were reaching for was real, though: an unresolvable name
 * yields `undefined`, which is indistinguishable from "not configured", so a
 * typo was silently ignored. These are optional settings — degrading to no
 * fallback beats refusing to start — so this reports rather than throws.
 */
function checkOptionalModelReferences(config: ConfigService): RuntimeDiagnostic[] {
  const diagnostics: RuntimeDiagnostic[] = []
  const optional = [
    { code: 'unknown_fallback_model', label: 'fallbackModel', raw: config.get().fallbackModel },
    { code: 'unknown_compact_model', label: 'compactModel', raw: config.get().compactModel },
  ] as const

  for (const { code, label, raw } of optional) {
    const configured = configuredModelName(raw)
    if (configured && !config.resolveModelReference(configured)) {
      diagnostics.push({
        code,
        severity: 'warning',
        message: `Unknown ${label} configured: ${configured}. It will be ignored.`,
      })
    }
  }
  return diagnostics
}
