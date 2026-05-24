#!/usr/bin/env node

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import { render } from 'ink'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { ConfigService } from '../../config/service.js'
import { loadMergedSettings, trustMcpServerLocally, validateSettings } from '../../config/settings.js'
import { createProvider } from '../../config/providers.js'
import { SessionStore } from '../../sessions/service.js'
import type { SessionMeta } from '../../sessions/service.js'
import { JsonlRecordStream } from '../../sessions/recordStream.js'
import { getAllTools } from '../../tools/index.js'
import { createAgentTool } from '../../tools/agentTool.js'
import { PermissionGate } from '../../harness/permissions.js'
import { ToolRunner } from '../../harness/toolRunner.js'
import { ContextBuilder } from '../../harness/contextBuilder.js'
import { SystemPromptSectionCache } from '../../harness/sections.js'
import { AgentLoop } from '../../harness/loop.js'
import { logDiagnostics, summarizeDiagnosticsForTui } from '../../harness/diagnostics.js'
import { SkillsService } from '../../services/skills/skillsService.js'
import { registerBuiltinCommands } from '../../commands/index.js'
import {
  loadMcpConfig,
  connectMcpServer,
  disconnectMcpServer,
  getMcpTimeoutMs,
  wrapMcpTool,
} from '../../services/mcp/index.js'
import type { McpTool } from '../../services/mcp/index.js'
import { createPromptProxy, createRecordProxy } from '../hooks/usePermission.js'
import { App } from '../components/App.js'
import type { AppRuntime } from '../components/App.js'
import { TUI_USAGE, parseTuiStartupCommand, resolveStartupSession } from './cli.js'
import type { TuiStartupCommand } from './cli.js'

const cwd = process.cwd()

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

  const store = new SessionStore(cwd)
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

  const modelConfig = config.getDefaultModel()
  if (!modelConfig) {
    console.error('No default model configured.')
    process.exit(1)
  }

  const initialModelKey = config.get().defaultModel
  if (!initialModelKey) {
    console.error('No default model configured.')
    process.exit(1)
  }
  const fallbackModelKey = config.get().fallbackModel
  if (fallbackModelKey && !config.getModel(fallbackModelKey)) {
    console.error(`Unknown fallback model configured: ${fallbackModelKey}`)
    process.exit(1)
  }

  const baseTools = await getAllTools()
  const skills = await new SkillsService(cwd).list()
  const promptSections = new SystemPromptSectionCache()

  // MCP integration: load config, connect each server, wrap tools.
  // Fail-open: any server that fails to connect is reported in the status line
  // but does not block startup.
  const mcpConfig = await loadMcpConfig(cwd, settings)
  const mcpClients: Client[] = []
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
      const client = await connectMcpServer(serverConfig)
      const listed = await client.listTools(undefined, { timeout: timeoutMs })
      const mcpTools: McpTool[] = listed.tools.map((t) => ({
        name: t.name,
        description: t.description ?? '',
        inputSchema: t.inputSchema,
        annotations: t.annotations as Record<string, unknown> | undefined,
      }))
      for (const mcpTool of mcpTools) {
        baseTools.push(wrapMcpTool(name, mcpTool, client))
      }
      promptSections.clear('user-context:available-tools')
      mcpClients.push(client)
      mcpSuccesses.push(`${name} (${mcpTools.length} tools)`)
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
  const permissionGate = new PermissionGate(promptProxy.prompt)

  const contextManagement = config.get().agent.contextManagement
  const isGitRepo = existsSync(join(cwd, '.git'))

  const createRuntime = (modelKey: string, runtimeSession: SessionMeta): AppRuntime => {
    const targetModelConfig = config.getModel(modelKey)
    if (!targetModelConfig) {
      throw new Error(`Unknown model: ${modelKey}`)
    }

    const targetProvider = createProvider(targetModelConfig)
    if (!targetProvider) {
      throw new Error(`Failed to create provider for: ${targetModelConfig.provider}`)
    }

    const fallbackModelConfig = fallbackModelKey && fallbackModelKey !== modelKey
      ? config.getModel(fallbackModelKey)
      : undefined
    const fallbackProvider = fallbackModelConfig ? createProvider(fallbackModelConfig) : undefined
    if (fallbackModelConfig && !fallbackProvider) {
      throw new Error(`Failed to create fallback provider for: ${fallbackModelConfig.provider}`)
    }

    const fallbackModel = fallbackModelConfig && fallbackProvider
      ? {
          provider: fallbackProvider,
          model: fallbackModelConfig.model,
          modelKey: fallbackModelKey,
          providerName: fallbackProvider.name,
          promptCacheRetention: fallbackModelConfig.promptCacheRetention,
        }
      : undefined

    const runtimeTools = [...baseTools]
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
      cwd,
      system: config.get().agent.system,
      skills,
      contextManagement,
      isGitRepo,
      hooks: settings.hooks,
      cacheRuntime: { settings, env: process.env },
    }))

    const recordStream = new JsonlRecordStream(store, runtimeSession.id)
    const runtimeToolRunner = new ToolRunner(runtimeTools, permissionGate, {
      onRecord: async (record) => {
        await recordStream.append(record)
        recordProxy.onRecord(record)
      },
    }, {
      preToolUse: settings.hooks?.preToolUse,
    })

    return {
      loop: new AgentLoop({
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
          taskState: new Map(),
        },
        system: config.get().agent.system,
        skills,
        promptCacheRetention: targetModelConfig.promptCacheRetention,
        contextManagement,
        isGitRepo,
        hooks: settings.hooks,
        cacheRuntime: { settings, env: process.env },
        fallbackModel,
        getCompactFailureCount: async () => (await store.load(runtimeSession.id))?.compactFailureCount ?? 0,
        setCompactFailureCount: async (count) => store.setCompactFailureCount(runtimeSession.id, count),
        recordStream,
        onRecord: (record) => recordProxy.onRecord(record),
      }),
      modelKey,
      modelConfig: targetModelConfig,
      providerName: targetProvider.name,
    }
  }

  const initialRuntime = createRuntime(initialModelKey, session)

  // Load existing records for display
  const existingLoad = await store.loadRecordsWithDiagnostics(session.id)
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
    await Promise.allSettled(mcpClients.map((c) => disconnectMcpServer(c)))
  }

  // Render the TUI
  const { waitUntilExit } = render(
    <App
      loop={initialRuntime.loop}
      modelKey={initialModelKey}
      store={store}
      session={session}
      modelConfig={initialRuntime.modelConfig}
      providerName={initialRuntime.providerName}
      availableModelKeys={Object.keys(config.get().models)}
      createRuntime={createRuntime}
      permissionGate={permissionGate}
      promptProxy={promptProxy}
      recordProxy={recordProxy}
      existingRecords={existingLoad.records}
      initialSystemMessages={initialSystemMessages}
      onBeforeExit={onBeforeExit}
    />,
    {
      exitOnCtrlC: false,
    },
  )

  await waitUntilExit()
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
