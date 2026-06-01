#!/usr/bin/env node

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import { render } from 'ink'
import { ConfigService } from '../../config/service.js'
import {
  loadMergedSettings,
  trustMcpServerLocally,
  validateSettings,
} from '../../config/settings.js'
import { createProvider } from '../../config/providers.js'
import type { RoutingRole } from '../../config/routing.js'
import { SessionStore } from '../../sessions/service.js'
import type { SessionMeta } from '../../sessions/service.js'
import { JsonlRecordStream } from '../../sessions/recordStream.js'
import { getAllTools } from '../../tools/index.js'
import { BUILT_IN_AGENT_DEFINITIONS, createAgentTool, prepareForkPreloadRecords } from '../../tools/agentTool.js'
import { restoreTaskStateFromRecords } from '../../tools/taskState.js'
import { PermissionGate, permissionRulesFromSettings, type DenialStateStore } from '../../harness/permissions.js'
import { ToolRunner } from '../../harness/toolRunner.js'
import { ContextBuilder } from '../../harness/contextBuilder.js'
import { SystemPromptSectionCache } from '../../harness/sections.js'
import { AgentLoop, type ActiveModelRuntime } from '../../harness/loop.js'
import { PlanModeManager } from '../../harness/planModeManager.js'
import { logDiagnostics, summarizeDiagnosticsForTui } from '../../harness/diagnostics.js'
import { SkillsService } from '../../services/skills/skillsService.js'
import { AgentDefinitionLoader } from '../../services/agents/agentDefinitionLoader.js'
import { registerBuiltinCommands } from '../../commands/index.js'
import {
  loadMcpConfig,
  connectManagedMcpServer,
  getMcpTimeoutMs,
  wrapMcpTool,
} from '../../services/mcp/index.js'
import type { ManagedMcpClient } from '../../services/mcp/index.js'
import type { McpTool } from '../../services/mcp/index.js'
import type { SessionRecord, Tool } from '../../harness/types.js'
import { createPromptProxy, createRecordProxy } from '../hooks/usePermission.js'
import { createExitPlanProxy } from '../hooks/useExitPlanPermission.js'
import { createEnterPlanProxy } from '../hooks/useEnterPlanPermission.js'
import { createAskUserQuestionProxy } from '../hooks/useAskUserQuestionPermission.js'
import { App } from '../components/App.js'
import type { AppRuntime } from '../components/App.js'
import { TUI_USAGE, parseTuiStartupCommand, resolveStartupSession } from './cli.js'
import type { TuiStartupCommand } from './cli.js'

const cwd = process.cwd()

function mergeAgentDefinitions<T extends { type: string }>(base: readonly T[], overrides: readonly T[]): T[] {
  const merged = new Map<string, T>()
  for (const definition of base) merged.set(definition.type, definition)
  for (const definition of overrides) merged.set(definition.type, definition)
  return [...merged.values()]
}

async function main() {
  if (!process.stdin.isTTY) {
    console.error('Error: myagent-tui requires an interactive terminal (TTY).')
    console.error('Use "myagent" for non-interactive mode.')
    process.exit(1)
  }

  let startupCommand: TuiStartupCommand
  try {
    startupCommand = parseTuiStartupCommand(process.argv.slice(2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }

  const store = new SessionStore(cwd, {
    ...(startupCommand.otlpEndpoint ? { otlpEndpoint: startupCommand.otlpEndpoint } : {}),
  })
  await store.init()

  if (startupCommand.kind === 'list') {
    const sessions = await store.list()
    if (sessions.length === 0) {
      console.log('No sessions found.')
    } else {
      for (const s of sessions) {
        console.log(`${s.shortId}  ${s.updatedAt}  ${s.title ?? '(untitled)'}  (${s.messageCount} msgs)`)
      }
    }
    process.exit(0)
  }

  let session: SessionMeta
  try {
    session = await resolveStartupSession(startupCommand, store)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    if (startupCommand.kind !== 'resume') {
      console.error(TUI_USAGE)
    }
    process.exit(1)
  }

  // Initialize infrastructure
  const settings = await loadMergedSettings(cwd)
  const config = new ConfigService(cwd)
  await config.load(settings)
  const settingsValidation = validateSettings(settings)
  if (!settingsValidation.valid) {
    console.error(`Invalid settings:\n${settingsValidation.errors.map((error) => `- ${error}`).join('\n')}`)
    process.exit(1)
  }

  const initialModelKey = config.resolveModelKeyFor(
    { kind: 'main' },
    { currentModelKey: config.get().defaultModel },
  )
  if (!initialModelKey) {
    console.error('No default model configured.')
    process.exit(1)
  }
  const modelConfig = config.getModel(initialModelKey)
  if (!modelConfig) {
    console.error(`Initial model could not be resolved: ${initialModelKey}`)
    process.exit(1)
  }
  const fallbackModelKey = config.resolveModelReference(config.get().fallbackModel)
  if (fallbackModelKey && !config.getModel(fallbackModelKey)) {
    console.error(`Unknown fallback model configured: ${config.get().fallbackModel}`)
    process.exit(1)
  }
  const compactModelKey = config.resolveModelReference(config.get().compactModel)
  if (compactModelKey && !config.getModel(compactModelKey)) {
    console.error(`Unknown compact model configured: ${config.get().compactModel}`)
    process.exit(1)
  }

  const baseTools = await getAllTools()
  const skills = await new SkillsService(cwd).list()
  let customAgentDefinitions = await new AgentDefinitionLoader(cwd).list()
  let agentDefinitions = mergeAgentDefinitions([...BUILT_IN_AGENT_DEFINITIONS], customAgentDefinitions)
  const reloadAgentDefinitions = async (): Promise<number> => {
    customAgentDefinitions = await new AgentDefinitionLoader(cwd).list()
    agentDefinitions = mergeAgentDefinitions([...BUILT_IN_AGENT_DEFINITIONS], customAgentDefinitions)
    promptSections.clear('system-prompt:available-tools')
    return customAgentDefinitions.length
  }
  const promptSections = new SystemPromptSectionCache()
  const runtimeToolSets = new Set<Tool[]>()
  const activeLoops = new Set<AgentLoop>()
  const mcpToolsByServer = new Map<string, Tool[]>()
  const refreshRuntimeTools = () => {
    const mcpTools = [...mcpToolsByServer.values()].flat()
    for (const tools of runtimeToolSets) {
      const agentTool = tools.find((tool) => tool.name === 'Agent')
      tools.splice(0, tools.length, ...baseTools, ...mcpTools)
      if (agentTool) tools.push(agentTool)
    }
    for (const loop of activeLoops) {
      loop.invalidateAvailableToolsSection()
    }
    promptSections.clear('system-prompt:available-tools')
  }

  // MCP integration: load config, connect each server, wrap tools.
  // Fail-open: any server that fails to connect is reported in the status line
  // but does not block startup.
  const mcpConfig = await loadMcpConfig(cwd, settings)
  const mcpClients: ManagedMcpClient[] = []
  const mcpSuccesses: string[] = []
  const mcpFailures: { name: string; error: string }[] = []
  const trustedMcpServers = new Set(settings.mcp?.trustedServers ?? [])
  const recordMcpFailure = async (name: string, error: string) => {
    mcpFailures.push({ name, error })
    await store.appendMetric(session.id, {
      event: 'mcp_connect_failed',
      server: name,
      error,
    })
  }

  for (const [name, serverConfig] of Object.entries(mcpConfig)) {
    try {
      if (!trustedMcpServers.has(name)) {
        const trusted = await promptTrustMcpServer(name, serverConfig)
        if (!trusted) {
          await recordMcpFailure(name, 'not trusted')
          continue
        }
        await trustMcpServerLocally(cwd, name)
        trustedMcpServers.add(name)
      }

      const timeoutMs = getMcpTimeoutMs(serverConfig)
      let manager: ManagedMcpClient
      manager = await connectManagedMcpServer(serverConfig, {
        onReconnect: async (client) => {
          await refreshMcpServerTools(name, client, manager, timeoutMs, mcpToolsByServer)
          refreshRuntimeTools()
        },
        onToolsChanged: (_client, tools) => {
          setMcpServerTools(name, tools, manager, mcpToolsByServer)
          refreshRuntimeTools()
        },
        onReconnectFailed: async (error) => {
          await store.appendMetric(session.id, {
            event: 'mcp_connect_failed',
            server: name,
            error: error.message,
          })
        },
      })
      await refreshMcpServerTools(name, manager, manager, timeoutMs, mcpToolsByServer)
      const toolCount = mcpToolsByServer.get(name)?.length ?? 0
      refreshRuntimeTools()
      mcpClients.push(manager)
      mcpSuccesses.push(`${name} (${toolCount} tools)`)
    } catch (error) {
      await recordMcpFailure(name, error instanceof Error ? error.message : String(error))
    }
  }

  let mcpStatusMessage: string | undefined
  if (mcpSuccesses.length > 0 || mcpFailures.length > 0) {
    const parts: string[] = []
    if (mcpSuccesses.length > 0) {
      parts.push(`MCP connected: ${mcpSuccesses.join(', ')}`)
    }
    if (mcpFailures.length > 0) {
      parts.push(
        `MCP failed: ${mcpFailures.map((f) => `${f.name} (${f.error})`).join(', ')}`,
      )
    }
    mcpStatusMessage = parts.join(' | ')
  }

  registerBuiltinCommands()

  // Create proxies - React hooks will inject real handlers after mount
  const promptProxy = createPromptProxy()
  const recordProxy = createRecordProxy()
  const exitPlanProxy = createExitPlanProxy()
  const enterPlanProxy = createEnterPlanProxy()
  const askUserQuestionProxy = createAskUserQuestionProxy()
  const denialStateStore: DenialStateStore = {
    getDenialState: async () => store.getDenialState(session.id),
    setDenialState: async (state) => store.setDenialState(session.id, state),
  }
  const permissionGate = new PermissionGate(promptProxy.prompt, permissionRulesFromSettings(settings.permissions), {
    denialStateStore,
    cwd,
  })

  const contextManagement = config.get().agent.contextManagement
  const isGitRepo = existsSync(join(cwd, '.git'))
  const restoredTaskStates = new Map<string, ReturnType<typeof restoreTaskStateFromRecords>>()

  const createActiveModelRuntime = (modelKey: string): ActiveModelRuntime => {
    const targetModelConfig = config.getModel(modelKey)
    if (!targetModelConfig) {
      throw new Error(`Unknown model: ${modelKey}`)
    }
    const targetProvider = createProvider(targetModelConfig)
    if (!targetProvider) {
      throw new Error(`Failed to create provider for: ${targetModelConfig.provider}`)
    }
    return {
      provider: targetProvider,
      model: targetModelConfig.model,
      modelKey,
      providerName: targetProvider.name,
      promptCacheRetention: targetModelConfig.promptCacheRetention,
    }
  }

  const createRoutedRuntime = (role: RoutingRole, currentModelKey: string): ActiveModelRuntime | undefined => {
    const routedModelKey = config.resolveModelKeyFor(role, { currentModelKey })
    return routedModelKey ? createActiveModelRuntime(routedModelKey) : undefined
  }

  const createRuntime = (modelKey: string, runtimeSession: SessionMeta): AppRuntime => {
    const targetModelConfig = config.getModel(modelKey)
    if (!targetModelConfig) {
      throw new Error(`Unknown model: ${modelKey}`)
    }

    const targetProvider = createProvider(targetModelConfig)
    if (!targetProvider) {
      throw new Error(`Failed to create provider for: ${targetModelConfig.provider}`)
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
        recordProxy.onRecord(record)
      },
      loadRecords: async () => recordStream.load(),
      openEnterPrompt: enterPlanProxy.open,
      openExitDialog: exitPlanProxy.open,
      onClearContextAndReplaceInput: async () => {},
    })
    permissionGate.setPlanSlugProvider(() => planModeManager.getSlug())
    const runtimeTools = [...baseTools, ...mcpToolsByServer.values()].flat()
    runtimeTools.push(createAgentTool({
      provider: targetProvider,
      model: targetModelConfig.model,
      modelKey,
      providerName: targetProvider.name,
      promptCacheRetention: targetModelConfig.promptCacheRetention,
      fallbackModel,
      tools: () => runtimeTools,
      permissionPrompt: promptProxy.prompt,
      permissionMode: () => permissionGate.getMode(),
      getConfigRules: () => permissionGate.getConfigRules(),
      getSessionRules: () => permissionGate.getSessionRules(),
      denialStateStore,
      cwd,
      system: config.get().agent.system,
      skills,
      agentDefinitions,
      loadParentRecords: async () => prepareForkPreloadRecords(await recordStream.load()),
      contextManagement,
      isGitRepo,
      hooks: settings.hooks,
      cacheRuntime: { settings, env: process.env },
      compactModel,
      onSubagentProgress: (event) => recordProxy.onProgress(event),
      resolveSubagentModel: (subagentType, requestedModelKey) => requestedModelKey
        ? createActiveModelRuntime(requestedModelKey)
        : createRoutedRuntime(
          { kind: 'subagent', type: subagentType },
          modelKey,
        ),
      getCompactFailureCount: async () => (await store.load(runtimeSession.id))?.compactFailureCount ?? 0,
      setCompactFailureCount: async (count) => store.setCompactFailureCount(runtimeSession.id, count),
      agentTimeoutMs: config.get().agent.agentTimeoutMs,
    }))

    runtimeToolSets.add(runtimeTools)
    const runtimeToolRunner = new ToolRunner(runtimeTools, permissionGate, {
      onRecord: async (record) => {
        await recordStream.append(record)
        recordProxy.onRecord(record)
      },
      onProgress: (event) => {
        recordProxy.onProgress(event)
      },
    }, {
      preToolUse: settings.hooks?.preToolUse,
    })

    loop = new AgentLoop({
        provider: targetProvider,
        model: targetModelConfig.model,
        modelKey,
        tools: runtimeTools,
        contextBuilder: new ContextBuilder(undefined, contextManagement, promptSections),
        toolRunner: runtimeToolRunner,
        toolContext: {
          cwd,
          sessionId: runtimeSession.id,
          readFiles: new Set(),
          readFileState: new Map(),
          invokedSkills: new Map(),
          taskState: new Map(restoredTaskStates.get(runtimeSession.id) ?? []),
          getPermissionMode: () => permissionGate.getMode(),
          setPermissionMode: (mode) => permissionGate.setMode(mode),
          exitPlanMode: () => permissionGate.exitPlanMode(),
          planModeBridge: planModeManager.buildBridge(),
          askUserQuestionBridge: askUserQuestionProxy,
        },
        system: config.get().agent.system,
        skills,
        promptCacheRetention: targetModelConfig.promptCacheRetention,
        contextManagement,
        isGitRepo,
        hooks: settings.hooks,
        cacheRuntime: { settings, env: process.env },
        permissionMode: () => permissionGate.getMode(),
        planModeManager,
        fallbackModel,
        compactModel,
        planModel,
        getCompactFailureCount: async () => (await store.load(runtimeSession.id))?.compactFailureCount ?? 0,
        setCompactFailureCount: async (count) => store.setCompactFailureCount(runtimeSession.id, count),
        recordStream,
        onRecord: (record) => recordProxy.onRecord(record),
      })
    activeLoops.add(loop)
    return {
      loop,
      planModeManager,
      modelKey,
      modelConfig: targetModelConfig,
      providerName: targetProvider.name,
      dispose: () => {
        runtimeToolSets.delete(runtimeTools)
        activeLoops.delete(loop)
      },
    }
  }

  // Load existing records for display
  const existingLoad = await store.loadRecordsWithDiagnostics(session.id)
  restoredTaskStates.set(session.id, restoreTaskStateFromRecords(existingLoad.records))
  const initialQueuedPrompt = process.env.MYAGENT_RESUME_INTERRUPTED_TURN
    ? latestRecoverableInterruption(existingLoad.records) ? 'continue' : undefined
    : undefined

  const initialRuntime = createRuntime(initialModelKey, session)

  logDiagnostics(existingLoad.diagnostics)
  const initialDiagnosticSummary = summarizeDiagnosticsForTui(existingLoad.diagnostics)
  const initialSystemMessages = [
    ...(initialDiagnosticSummary
      ? [{
          kind: 'system' as const,
          id: randomUUID(),
          content: initialDiagnosticSummary,
          createdAt: new Date().toISOString(),
        }]
      : []),
    ...(mcpStatusMessage
      ? [{
          kind: 'system' as const,
          id: randomUUID(),
          content: mcpStatusMessage,
          createdAt: new Date().toISOString(),
        }]
      : []),
  ]

  const onBeforeExit = async () => {
    // Disconnect all MCP clients on exit. Swallow errors so a misbehaving
    // server cannot prevent the TUI from exiting cleanly.
    await Promise.allSettled(mcpClients.map((c) => c.close()))
  }
  // Render the TUI
  const { waitUntilExit } = render(
    <App
      loop={initialRuntime.loop}
      planModeManager={initialRuntime.planModeManager}
      modelKey={initialModelKey}
      store={store}
      session={session}
      modelConfig={initialRuntime.modelConfig}
      providerName={initialRuntime.providerName}
      dispose={initialRuntime.dispose}
      availableModelKeys={Object.keys(config.get().models)}
      resolveModelInput={(input, currentModelKey) => config.resolveModelInput(input, { currentModelKey })}
      providerConfig={config}
      createRuntime={createRuntime}
      permissionGate={permissionGate}
      promptProxy={promptProxy}
      recordProxy={recordProxy}
      exitPlanProxy={exitPlanProxy}
      enterPlanProxy={enterPlanProxy}
      askUserQuestionProxy={askUserQuestionProxy}
      existingRecords={existingLoad.records}
      initialSystemMessages={initialSystemMessages}
      initialQueuedPrompt={initialQueuedPrompt}
      onBeforeExit={onBeforeExit}
      reloadAgentDefinitions={reloadAgentDefinitions}
    />,
    {
      exitOnCtrlC: false,
    },
  )

  await waitUntilExit()
}

function latestRecoverableInterruption(records: readonly SessionRecord[]): boolean {
  return [...records]
    .reverse()
    .some((record) => record.type === 'turn_interruption' && record.recoverable && !record.consumedAt)
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})

async function promptTrustMcpServer(name: string, serverConfig: { transport: string; command?: string; args?: string[]; url?: string }): Promise<boolean> {
  const rl = createInterface({ input, output })
  try {
    console.log(`\nMCP server "${name}" is not trusted yet.`)
    console.log(`Transport: ${serverConfig.transport}`)
    if (serverConfig.transport === 'stdio') {
      console.log(`Command: ${[serverConfig.command, ...(serverConfig.args ?? [])].filter(Boolean).join(' ')}`)
    } else if (serverConfig.url) {
      console.log(`URL: ${serverConfig.url}`)
    }
    const answer = await rl.question('Trust and start this MCP server? [y/N] ')
    return answer.trim().toLowerCase() === 'y' || answer.trim().toLowerCase() === 'yes'
  } finally {
    rl.close()
  }
}

async function refreshMcpServerTools(
  name: string,
  client: Pick<ManagedMcpClient, 'listTools'>,
  toolClient: ManagedMcpClient,
  timeoutMs: number,
  toolsByServer: Map<string, Tool[]>,
): Promise<void> {
  const listed = await client.listTools(undefined, { timeout: timeoutMs })
  setMcpServerTools(name, listed.tools, toolClient, toolsByServer)
}

function setMcpServerTools(
  name: string,
  listedTools: Awaited<ReturnType<ManagedMcpClient['listTools']>>['tools'],
  toolClient: ManagedMcpClient,
  toolsByServer: Map<string, Tool[]>,
): void {
  const mcpTools: McpTool[] = listedTools.map((t) => ({
    name: t.name,
    description: t.description ?? '',
    inputSchema: t.inputSchema,
    annotations: t.annotations as Record<string, unknown> | undefined,
  }))
  toolsByServer.set(name, mcpTools.map((mcpTool) => wrapMcpTool(name, mcpTool, toolClient)))
}
