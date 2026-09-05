import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { ConfigService } from '../config/service.js'
import {
  loadMergedSettings,
  validateSettings,
} from '../config/settings.js'
import { clampEffort } from '../config/effort.js'
import { permissionRulesFromSettings } from '../harness/permissions.js'
import type { RuntimeDiagnostic } from '../harness/diagnostics.js'
import { getAllTools } from '../tools/index.js'
import { BUILT_IN_AGENT_DEFINITIONS } from '../tools/agentTool.js'
import { SkillsService } from '../services/skills/skillsService.js'
import { AgentDefinitionLoader } from '../services/agents/agentDefinitionLoader.js'
import { BackgroundTaskRegistry } from '../services/backgroundTasks/registry.js'
import { clearProjectContextCache, getProjectContext } from '../services/context/projectContext.js'
import type { SessionMeta } from '../sessions/service.js'
import { registerBuiltinCommands } from '../commands/index.js'
import { CommandRegistry } from '../commands/registry.js'
import { registerSkillCommands } from '../commands/skills.js'
import { createActiveModelRuntimeFactory } from './createRuntime.js'
import { RuntimeStartupError } from './errors.js'
import { connectMcpServers } from './mcp.js'
import { createSessionScope, type SessionScopeDeps } from './sessionScope.js'
import { ToolRegistry } from './toolRegistry.js'
import type { ManagedMcpClient, McpServerConfig } from '../services/mcp/index.js'
import type { BootstrapOptions, McpConnectionStatus, RuntimeHost, SessionScope } from './types.js'

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

  const backgroundTasks = new BackgroundTaskRegistry(
    (sessionId, record) => store.appendRecord(sessionId, record),
  )

  // One per project, like `toolRegistry` below: `registerSkillCommands` reads
  // `<cwd>/.myagent/skills/`, so a process-wide registry would let a second
  // project's skills answer this one's slash commands.
  const commands = new CommandRegistry()

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

  // `AGENTS.md` / `CLAUDE.md` and the rules files above them, merged once here.
  // Mutable for the same reason `settings` is: `reloadSettings()` re-reads it
  // and the next runtime built picks up the new contents.
  let projectContext = await getProjectContext(cwd)

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
  const modelDiagnostics = [
    ...checkLegacyModelTiers(config),
    ...checkOptionalModelReferences(config),
  ]
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
    await registerSkillCommands(commands, cwd)
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
   *
   * The project context (`AGENTS.md` / `CLAUDE.md`) rides along: it is not a
   * settings layer, but it is captured per runtime the same way, and this is
   * the one reload every host already calls, so an edited instructions file
   * reaches the next runtime instead of waiting for a restart.
   *
   * Every open scope gets the new rules, not just the newest one: each holds
   * its own `PermissionGate`, so reaching only one would leave the other tabs
   * enforcing the rules the process started with.
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

    clearProjectContextCache(cwd)
    const nextProjectContext = await getProjectContext(cwd)
    const projectContextChanged = nextProjectContext !== projectContext
    projectContext = nextProjectContext

    const rules = permissionRulesFromSettings(settings.permissions)
    for (const scope of scopes) scope.permissionGate.setConfigRules(rules)
    return { needsRuntimeRebuild: hooksChanged || projectContextChanged }
  }

  // Fail-open: a server that fails to connect is reported but does not block
  // startup. Trust is confirmed through the host, before it owns stdin.
  const recordMcpFailure = async (name: string, error: string): Promise<void> => {
    await store.appendMetric(session.id, {
      event: 'mcp_connect_failed',
      server: name,
      error,
    })
  }

  let mcpClients: ManagedMcpClient[] = []
  // One object for the life of the project: hosts read `ProjectRuntime.mcp`
  // directly, so a reload rewrites its contents instead of replacing it.
  const mcpStatus: McpConnectionStatus = { connected: [], failed: [] }
  const connectMcp = async (
    confirmTrust: (name: string, server: McpServerConfig) => Promise<boolean>,
  ): Promise<void> => {
    const result = await connectMcpServers({
      cwd,
      settings,
      registry: toolRegistry,
      confirmTrust,
      onConnectFailure: recordMcpFailure,
    })
    mcpClients = result.clients
    mcpStatus.connected.splice(0, mcpStatus.connected.length, ...result.status.connected)
    mcpStatus.failed.splice(0, mcpStatus.failed.length, ...result.status.failed)
  }
  await connectMcp(confirmMcpTrust)

  /**
   * Reconnects every MCP server from the current settings.
   *
   * Tools are dropped *before* reconnecting: a server the settings no longer
   * name would otherwise keep its tools in every live runtime's tool array,
   * since the registry only ever hears about servers that connect.
   *
   * Never prompts. `confirmMcpTrust` is a pre-channel prompt by construction
   * (it runs before any UI exists), and a reload happens while a UI is up, so
   * an untrusted server is reported as such rather than asked about.
   */
  const reloadMcpServers = async (): Promise<void> => {
    const previousClients = mcpClients
    const previousServers = mcpStatus.connected.map((entry) => entry.name)
    mcpClients = []
    await Promise.allSettled(previousClients.map((client) => client.close()))
    for (const name of previousServers) toolRegistry.removeServerTools(name)
    await connectMcp(async () => false)
  }

  registerBuiltinCommands(commands)
  await registerSkillCommands(commands, cwd)

  const contextManagement = config.get().agent.contextManagement
  const isGitRepo = existsSync(join(cwd, '.git'))

  const createActiveModelRuntime = createActiveModelRuntimeFactory(config)

  const scopeDeps: SessionScopeDeps = {
    cwd,
    config,
    store,
    getSettings: () => settings,
    getSkills: () => skills,
    getAgentDefinitions: () => agentDefinitions,
    getProjectContext: () => projectContext,
    toolRegistry,
    backgroundTasks,
    contextManagement,
    isGitRepo,
    initialEffort: clampedInitialEffort,
    createActiveModelRuntime,
  }

  // Every scope currently open. `reloadSettings` has to reach all of them, and
  // `shutdown` has to release all of them.
  const scopes = new Set<SessionScope>()
  const openScope = async (target: SessionMeta): Promise<SessionScope> => {
    const created = await createSessionScope(scopeDeps, target)
    // Wrapped rather than handed a deregister callback: the scope has no reason
    // to know it is being tracked, and this keeps the set private to bootstrap.
    const scope: SessionScope = {
      ...created,
      dispose: () => {
        scopes.delete(scope)
        created.dispose()
      },
    }
    scopes.add(scope)
    return scope
  }

  const initialScope = await openScope(session)

  return {
    ...initialScope,
    // The initial scope shows the project's startup diagnostics too — they need
    // surfacing once, and this is the scope that surfaces them.
    diagnostics: [...modelDiagnostics, ...initialScope.diagnostics],
    cwd,
    config,
    store,
    backgroundTasks,
    commands,
    mcp: mcpStatus,
    initialModelKey,
    initialEffort: typeof clampedInitialEffort === 'string' ? clampedInitialEffort : undefined,
    configuredEffortLevel,
    createActiveModelRuntime,
    openScope,
    getSettings: () => settings,
    getProjectContext: () => projectContext,
    listAgentDefinitions: () => agentDefinitions,
    reloadAgentDefinitions,
    reloadSkills,
    reloadSettings,
    reloadMcpServers,
    shutdown: async (reason: string) => {
      // Swallow errors so a misbehaving server cannot prevent a clean exit.
      await backgroundTasks.stopAll(undefined, reason)
      await Promise.allSettled(mcpClients.map((client) => client.close()))
      for (const scope of [...scopes]) scope.dispose()
    },
  }
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
 * Surfaces tier-era config that `ConfigService.load()` already migrated.
 *
 * The `fast`/`balanced`/`powerful` tiers and the `profiles` layer under them are
 * gone; a config written before that still parses, so the only way the user
 * learns their `routing` no longer means what it said is a warning here. Reports
 * rather than throws, for the same reason `checkOptionalModelReferences` does:
 * refusing to start over a setting we already repaired helps nobody.
 */
function checkLegacyModelTiers(config: ConfigService): RuntimeDiagnostic[] {
  return config.getLegacyModelFindings().map((message) => ({
    code: 'legacy_model_tiers',
    severity: 'warning' as const,
    message,
  }))
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
