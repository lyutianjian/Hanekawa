import test, { beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { mkdtempSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { z } from 'zod/v3'
import { bootstrap, RuntimeStartupError } from '../src/runtime/index.js'
import { SessionStore } from '../src/sessions/service.js'
import type { SessionMeta } from '../src/sessions/service.js'
import type { SessionRecord, Tool } from '../src/harness/types.js'
import type { McpServerConfig } from '../src/services/mcp/index.js'

// ConfigService and loadMergedSettings both layer a shared `~/.myagent`
// beneath the project one, so every test needs its own home.
beforeEach(() => {
  const testHome = mkdtempSync(path.join(tmpdir(), 'myagent-home-'))
  process.env.USERPROFILE = testHome
  process.env.HOME = testHome
})

const MODEL_CONFIG = {
  models: { main: { provider: 'anthropic', model: 'claude-test', apiKey: 'test-key' } },
  defaultModel: 'main',
}

async function createProject(options: {
  config?: Record<string, unknown>
  settings?: Record<string, unknown>
} = {}): Promise<{ cwd: string; store: SessionStore; session: SessionMeta }> {
  const cwd = await mkdtemp(path.join(tmpdir(), 'myagent-bootstrap-'))
  await mkdir(path.join(cwd, '.myagent'), { recursive: true })
  await writeFile(
    path.join(cwd, '.myagent', 'config.json'),
    JSON.stringify(options.config ?? MODEL_CONFIG),
    'utf8',
  )
  if (options.settings) {
    await writeFile(
      path.join(cwd, '.myagent', 'settings.json'),
      JSON.stringify(options.settings),
      'utf8',
    )
  }
  const store = new SessionStore(cwd)
  await store.init()
  return { cwd, store, session: await store.create('bootstrap test') }
}

const denyTrust = async () => false

test('invalid settings surface as a startup error instead of exiting', async () => {
  const { cwd, store, session } = await createProject({ settings: { effortLevel: 'turbo' } })

  await assert.rejects(
    () => bootstrap({ cwd, store, session, confirmMcpTrust: denyTrust }),
    (error: unknown) => {
      assert.ok(error instanceof RuntimeStartupError)
      assert.equal(error.code, 'invalid_settings')
      assert.match(error.message, /effortLevel must be one of/)
      return true
    },
  )
})

test('a project without a usable default model fails to bootstrap', async () => {
  const { cwd, store, session } = await createProject({ config: { models: {} } })

  await assert.rejects(
    () => bootstrap({ cwd, store, session, confirmMcpTrust: denyTrust }),
    (error: unknown) => {
      assert.ok(error instanceof RuntimeStartupError)
      assert.equal(error.code, 'no_default_model')
      return true
    },
  )
})

test('bootstrap assembles a runtime bound to the configured model', async () => {
  const { cwd, store, session } = await createProject()
  const host = await bootstrap({ cwd, store, session, confirmMcpTrust: denyTrust })

  assert.equal(host.initialModelKey, 'main')
  assert.deepEqual(host.mcp, { connected: [], failed: [] })
  assert.equal(host.hasRecoverableInterruption, false)

  const runtime = host.createRuntime(host.initialModelKey, session, host.existingRecords)
  assert.equal(runtime.modelKey, 'main')
  assert.equal(runtime.modelConfig.model, 'claude-test')
  assert.equal(runtime.providerName, 'anthropic')
  assert.equal(typeof runtime.run, 'function')

  runtime.dispose()
  await host.shutdown('test over')
})

test('startup effort is clamped to the model maximum, keeping the configured level', async () => {
  const { cwd, store, session } = await createProject({
    config: {
      models: { main: { provider: 'anthropic', model: 'claude-test', maxEffort: 'medium' } },
      defaultModel: 'main',
    },
    settings: { effortLevel: 'max' },
  })

  const host = await bootstrap({ cwd, store, session, confirmMcpTrust: denyTrust })

  assert.equal(host.initialEffort, 'medium')
  assert.equal(host.configuredEffortLevel, 'max')
  await host.shutdown('test over')
})

test('the permission bridge is wired into the gate the runtime uses', async () => {
  const { cwd, store, session } = await createProject()
  const host = await bootstrap({ cwd, store, session, confirmMcpTrust: denyTrust })

  const asked: string[] = []
  host.bridges.prompt.setPrompt(async (request) => {
    asked.push(request.tool.name)
    return true
  })

  const dangerousTool: Tool = {
    name: 'Dangerous',
    description: 'dangerous',
    inputSchema: z.object({}).strict(),
    riskLevel: 'dangerous',
    execute: async () => ({ ok: true, content: 'done' }),
  }
  const approved = await host.permissionGate.approve(dangerousTool, {})

  assert.equal(approved, true)
  assert.deepEqual(asked, ['Dangerous'])
  await host.shutdown('test over')
})

test('an MCP server the host refuses to trust is reported without blocking startup', async () => {
  const { cwd, store, session } = await createProject({
    settings: {
      mcpServers: {
        untrusted: { transport: 'stdio', command: 'does-not-exist' },
      },
    },
  })

  const confirmed: Array<{ name: string; server: McpServerConfig }> = []
  const host = await bootstrap({
    cwd,
    store,
    session,
    confirmMcpTrust: async (name, server) => {
      confirmed.push({ name, server })
      return false
    },
  })

  assert.deepEqual(confirmed.map((entry) => entry.name), ['untrusted'])
  assert.equal(confirmed[0]?.server.command, 'does-not-exist')
  assert.deepEqual(host.mcp.connected, [])
  assert.deepEqual(host.mcp.failed, [{ name: 'untrusted', error: 'not trusted' }])

  // Fail-open: the runtime is still usable.
  const runtime = host.createRuntime(host.initialModelKey, session)
  runtime.dispose()
  await host.shutdown('test over')
})

test('an unconsumed recoverable interruption is reported to the host', async () => {
  const { cwd, store, session } = await createProject()
  const interruption: SessionRecord = {
    id: 'interruption-1',
    type: 'turn_interruption',
    userMessageId: 'msg-1',
    prompt: 'do the thing',
    remainingTasks: [],
    recoverable: true,
    createdAt: new Date().toISOString(),
  }
  await store.appendRecord(session.id, interruption)

  const host = await bootstrap({ cwd, store, session, confirmMcpTrust: denyTrust })

  assert.equal(host.hasRecoverableInterruption, true)
  assert.equal(host.existingRecords.length, 1)
  await host.shutdown('test over')
})
