#!/usr/bin/env node

import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import { render } from '../ink.js'
import { ClockProvider } from '../clock/ClockContext.js'
import { installTerminalFocusFilter } from '../clock/terminalFocusState.js'
import { saveEffortLevel, setLocalThinking } from '../../config/settings.js'
import type { EffortLevel } from '../../config/effort.js'
import { SessionStore } from '../../sessions/service.js'
import type { SessionMeta } from '../../sessions/service.js'
import { logDiagnostics } from '../../harness/diagnostics.js'
import type { McpServerConfig } from '../../services/mcp/index.js'
import { bootstrap, RuntimeStartupError } from '../../runtime/index.js'
import type { RuntimeHost } from '../../runtime/index.js'
import { buildStartupNotices, resolveInitialQueuedPrompt } from '../../runtime/startupNotices.js'
import { createSessionPane } from '../../runtime/sessionWorkspace.js'
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

  // The runtime slot and the session controller are the headless half of the
  // app. `createSessionPane` assembles them so a different shell — or a second
  // tab in the same process — reuses them verbatim and only replaces the view
  // layer. `host` stands in for both halves here: `RuntimeHost` is exactly the
  // intersection of the project and its one scope.
  const pane = createSessionPane(host, host)
  const runtimeSlot = pane.runtimeSlot
  const sessionController = pane.controller

  const initialQueuedPrompt = resolveInitialQueuedPrompt(host.hasRecoverableInterruption)

  logDiagnostics(host.diagnostics)
  const initialSystemMessages = buildStartupNotices(host).map((notice) => ({
    kind: 'system' as const,
    id: randomUUID(),
    content: notice.content,
    createdAt: new Date().toISOString(),
  }))

  // Render the TUI
  const { waitUntilExit } = render(
    <ClockProvider>
      <App
      runtimeSlot={runtimeSlot}
      sessionController={sessionController}
      store={store}
      session={session}
      commands={host.commands}
      availableModelKeys={Object.keys(host.config.get().models)}
      providerConfig={host.config}
      createRuntime={host.createRuntime}
      createActiveModelRuntime={host.createActiveModelRuntime}
      permissionGate={host.permissionGate}
      promptProxy={host.bridges.prompt}
      exitPlanProxy={host.bridges.exitPlan}
      enterPlanProxy={host.bridges.enterPlan}
      askUserQuestionProxy={host.bridges.askUserQuestion}
      existingRecords={host.existingRecords}
      initialSystemMessages={initialSystemMessages}
      initialQueuedPrompt={initialQueuedPrompt}
      onBeforeExit={() => host.shutdown('TUI exited')}
      backgroundTasks={host.backgroundTasks}
      attachments={host.attachments}
      reloadAgentDefinitions={host.reloadAgentDefinitions}
      reloadSkills={host.reloadSkills}
      onEffortLevelChange={async (level) => {
        try { await saveEffortLevel(level as EffortLevel) } catch { /* non-critical */ }
      }}
      // Reloaded as well as written: a later runtime rebuild reads the settings
      // the project holds, not the file, so without this `/thinking off` would
      // come back on at the next `/model` switch.
      onThinkingChange={async (enabled) => {
        await setLocalThinking(host.cwd, enabled)
        await host.reloadSettings()
      }}
      />
      </ClockProvider>,
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
