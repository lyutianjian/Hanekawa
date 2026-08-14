#!/usr/bin/env node

import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import { render } from '../ink.js'
import { ClockProvider } from '../clock/ClockContext.js'
import { installTerminalFocusFilter } from '../clock/terminalFocusState.js'
import { saveEffortLevel } from '../../config/settings.js'
import type { EffortLevel } from '../../config/effort.js'
import { SessionStore } from '../../sessions/service.js'
import type { SessionMeta } from '../../sessions/service.js'
import { logDiagnostics, summarizeDiagnosticsForTui } from '../../harness/diagnostics.js'
import type { McpServerConfig } from '../../services/mcp/index.js'
import { bootstrap, RuntimeStartupError } from '../../runtime/index.js'
import type { McpConnectionStatus, RuntimeHost } from '../../runtime/index.js'
import { App } from '../components/App.js'
import { TUI_USAGE, isResumableSession, parseTuiStartupCommand, resolveStartupSession } from './cli.js'
import type { TuiStartupCommand } from './cli.js'

async function main() {
  if (!process.stdin.isTTY) {
    console.error('Error: myagent-tui requires an interactive terminal (TTY).')
    console.error('Use "myagent" for non-interactive mode.')
    process.exit(1)
  }

  // Register before Ink attaches its own 'readable' listener so DECSET 1004
  // focus sequences (`ESC [ I` / `ESC [ O`) are stripped instead of being
  // delivered to useInput as literal '[I' / '[O' text.
  installTerminalFocusFilter(process.stdin)

  const cwd = process.cwd()

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
    const sessions = (await store.list()).filter(isResumableSession)
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

  // Everything terminal-independent lives in src/runtime. MCP trust is the one
  // prompt that must happen here, before Ink takes over stdin.
  let host: RuntimeHost
  try {
    host = await bootstrap({ cwd, store, session, confirmMcpTrust: promptTrustMcpServer })
  } catch (error) {
    if (error instanceof RuntimeStartupError) {
      console.error(error.message)
      process.exit(1)
    }
    throw error
  }

  const initialRuntime = host.createRuntime(host.initialModelKey, session, host.existingRecords)

  const initialQueuedPrompt = process.env.MYAGENT_RESUME_INTERRUPTED_TURN
    ? host.hasRecoverableInterruption ? 'continue' : undefined
    : undefined

  logDiagnostics(host.diagnostics)
  const initialSystemMessages = [
    summarizeDiagnosticsForTui(host.diagnostics),
    formatMcpStatus(host.mcp),
  ]
    .filter((content): content is string => Boolean(content))
    .map((content) => ({
      kind: 'system' as const,
      id: randomUUID(),
      content,
      createdAt: new Date().toISOString(),
    }))

  // Render the TUI
  const { waitUntilExit } = render(
    <ClockProvider>
      <App
      loop={initialRuntime.loop}
      planModeManager={initialRuntime.planModeManager}
      modelKey={host.initialModelKey}
      store={store}
      session={session}
      modelConfig={initialRuntime.modelConfig}
      providerName={initialRuntime.providerName}
      dispose={initialRuntime.dispose}
      availableModelKeys={Object.keys(host.config.get().models)}
      resolveModelInput={(input, currentModelKey) => host.config.resolveModelInput(input, { currentModelKey })}
      providerConfig={host.config}
      createRuntime={host.createRuntime}
      createActiveModelRuntime={host.createActiveModelRuntime}
      permissionGate={host.permissionGate}
      promptProxy={host.bridges.prompt}
      recordProxy={host.bridges.record}
      exitPlanProxy={host.bridges.exitPlan}
      enterPlanProxy={host.bridges.enterPlan}
      askUserQuestionProxy={host.bridges.askUserQuestion}
      existingRecords={host.existingRecords}
      initialSystemMessages={initialSystemMessages}
      initialQueuedPrompt={initialQueuedPrompt}
      onBeforeExit={() => host.shutdown('TUI exited')}
      backgroundTasks={host.backgroundTasks}
      reloadAgentDefinitions={host.reloadAgentDefinitions}
      initialEffortLevel={host.initialEffort ?? host.configuredEffortLevel}
      onEffortLevelChange={async (level) => {
        try { await saveEffortLevel(level as EffortLevel) } catch { /* non-critical */ }
      }}
      />
      </ClockProvider>,
    {
      exitOnCtrlC: false,
    },
  )

  await waitUntilExit()
}

function formatMcpStatus(status: McpConnectionStatus): string | undefined {
  const parts: string[] = []
  if (status.connected.length > 0) {
    parts.push(`MCP connected: ${status.connected.map((s) => `${s.name} (${s.toolCount} tools)`).join(', ')}`)
  }
  if (status.failed.length > 0) {
    parts.push(`MCP failed: ${status.failed.map((f) => `${f.name} (${f.error})`).join(', ')}`)
  }
  return parts.length > 0 ? parts.join(' | ') : undefined
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})

async function promptTrustMcpServer(name: string, serverConfig: McpServerConfig): Promise<boolean> {
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
