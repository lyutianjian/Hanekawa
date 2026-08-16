import test, { beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { mkdtempSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { z } from 'zod/v3'
import { bootstrap } from '../src/runtime/index.js'
import type { SessionScope } from '../src/runtime/index.js'
import { SessionStore } from '../src/sessions/service.js'
import type { SessionMeta } from '../src/sessions/service.js'
import type { PermissionRequest } from '../src/harness/permissions.js'
import type { SessionRecord, Tool } from '../src/harness/types.js'

/**
 * What one process may hold twice.
 *
 * `bootstrap()` used to assemble the bridges, the permission gate and the
 * prompt-section cache inline and exactly once, which meant a second concurrent
 * session would have had to share all three. These tests pin the seam that
 * split them: everything on a `SessionScope` is per-conversation, everything on
 * the `ProjectRuntime` is shared on purpose, and the sharing is what makes two
 * tabs cheap rather than what makes them wrong.
 */

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
  const cwd = await mkdtemp(path.join(tmpdir(), 'myagent-scope-'))
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
  return { cwd, store, session: await store.create('scope test') }
}

const denyTrust = async () => false

function tool(name: string): Tool {
  return {
    name,
    description: name,
    inputSchema: z.object({}).strict(),
    riskLevel: 'dangerous',
    execute: async () => ({ ok: true, content: 'done' }),
  }
}

function permissionRequest(name: string): PermissionRequest {
  return { tool: tool(name), input: {}, reason: 'test', source: 'mode', denialStreak: 0 }
}

test('two scopes route their prompts to their own UI, never to each other', async () => {
  const { cwd, store, session } = await createProject()
  const host = await bootstrap({ cwd, store, session, confirmMcpTrust: denyTrust })
  const second = await host.openScope(await store.create('second tab'))

  assert.notEqual(second.bridges, host.bridges)
  assert.notEqual(second.permissionGate, host.permissionGate)
  assert.notEqual(second.promptSections, host.promptSections,
    'the cached Environment block names a model, so a shared cache leaks one tab\'s model into the other')

  const askedFirst: string[] = []
  const askedSecond: string[] = []
  host.bridges.prompt.setPrompt(async (request) => {
    askedFirst.push(request.tool.name)
    return true
  })
  second.bridges.prompt.setPrompt(async (request) => {
    askedSecond.push(request.tool.name)
    return true
  })

  assert.equal(await host.permissionGate.approve(tool('First'), {}), true)
  assert.equal(await second.permissionGate.approve(tool('Second'), {}), true)

  // A single set of bridges has one handler slot per proxy, so sharing would
  // send whichever scope installed last both tabs' prompts.
  assert.deepEqual(askedFirst, ['First'])
  assert.deepEqual(askedSecond, ['Second'])

  await host.shutdown('test over')
})

test('a permission mode change stays inside the scope that made it', async () => {
  const { cwd, store, session } = await createProject()
  const host = await bootstrap({ cwd, store, session, confirmMcpTrust: denyTrust })
  const second = await host.openScope(await store.create('second tab'))

  host.permissionGate.setMode('plan')

  assert.equal(host.permissionGate.getMode(), 'plan')
  assert.equal(second.permissionGate.getMode(), 'default',
    'entering plan mode in one tab must not restrict the other')

  second.permissionGate.setMode('bypass')
  assert.equal(host.permissionGate.getMode(), 'plan')

  await host.shutdown('test over')
})

test('reloading settings reaches every open scope, not just the newest', async () => {
  const { cwd, store, session } = await createProject({
    settings: { permissions: { deny: ['Bash(rm *)'] } },
  })
  const host = await bootstrap({ cwd, store, session, confirmMcpTrust: denyTrust })
  const second = await host.openScope(await store.create('second tab'))

  assert.equal(host.permissionGate.getConfigRules().length, 1)
  assert.equal(second.permissionGate.getConfigRules().length, 1)

  await writeFile(
    path.join(cwd, '.myagent', 'settings.json'),
    JSON.stringify({ permissions: { deny: ['Bash(rm *)', 'Bash(curl *)'] } }),
    'utf8',
  )
  await host.reloadSettings()

  // Each scope holds its own gate, so reaching only one would leave the other
  // tab enforcing the rules the process started with.
  assert.equal(host.permissionGate.getConfigRules().length, 2)
  assert.equal(second.permissionGate.getConfigRules().length, 2)

  await host.shutdown('test over')
})

test('denial counters are per scope and land in each scope\'s own session', async () => {
  const { cwd, store, session } = await createProject()
  const host = await bootstrap({ cwd, store, session, confirmMcpTrust: denyTrust })
  const other = await store.create('second tab')
  const second = await host.openScope(other)

  const bashTool: Tool = {
    name: 'Bash',
    description: 'run a command',
    inputSchema: z.object({ command: z.string() }).strict(),
    riskLevel: 'confirm',
    execute: async () => ({ ok: true, content: 'done' }),
  }
  const denied = { command: 'cat .git/config' }

  assert.equal(await host.permissionGate.approve(bashTool, denied), false)
  assert.equal(await second.permissionGate.approve(bashTool, denied), false)

  // One shared gate would have written a streak of 2 into one session; the
  // anti-loop machinery escalates on that count, so a second tab would push the
  // first one into real prompts.
  assert.deepEqual(await store.getDenialState(session.id), { streaks: { Bash: 1 }, total: 1 })
  assert.deepEqual(await store.getDenialState(other.id), { streaks: { Bash: 1 }, total: 1 })

  await host.shutdown('test over')
})

test('disposing a scope restores the four asymmetric fallbacks', async () => {
  const { cwd, store, session } = await createProject()
  const host = await bootstrap({ cwd, store, session, confirmMcpTrust: denyTrust })
  const scope = await host.openScope(await store.create('second tab'))

  // Parked before dispose: with no UI attached the permission bridge waits
  // rather than auto-denying, and only a drain settles it.
  const parked = scope.bridges.prompt.prompt(permissionRequest('Parked'))

  const records: SessionRecord[] = []
  scope.bridges.record.setHandler((record) => { records.push(record) })
  scope.bridges.askUserQuestion.setOpen(async () => ({ kind: 'answers', answers: {} }))
  scope.bridges.enterPlan.setOpen(async () => false)
  scope.bridges.exitPlan.setOpen(async () => ({ kind: 'approve_restore_keep' }))

  scope.dispose()

  assert.equal(await parked, false, 'a UI that is never coming has to release the tool call')
  assert.equal(await scope.bridges.enterPlan.open(), true,
    'entering plan mode only ever restricts the agent, so its fallback approves')
  assert.deepEqual(await scope.bridges.exitPlan.open({ planContent: '', planFilePath: '' }),
    { kind: 'reject', feedback: '' })
  const asked = await scope.bridges.askUserQuestion.ask({ questions: [] })
  assert.equal(asked.kind, 'rejected')

  scope.bridges.record.onRecord({
    id: 'r1',
    type: 'message',
    role: 'user',
    content: 'dropped',
    createdAt: new Date().toISOString(),
  } as SessionRecord)
  assert.deepEqual(records, [], 'the record bridge drops rather than answering')

  await host.shutdown('test over')
})

test('shutdown releases every open scope, not only the one bootstrap opened', async () => {
  const { cwd, store, session } = await createProject()
  const host = await bootstrap({ cwd, store, session, confirmMcpTrust: denyTrust })
  const second = await host.openScope(await store.create('second tab'))

  const parkedFirst = host.bridges.prompt.prompt(permissionRequest('First'))
  const parkedSecond = second.bridges.prompt.prompt(permissionRequest('Second'))

  await host.shutdown('test over')

  assert.equal(await parkedFirst, false)
  assert.equal(await parkedSecond, false)
})

test('a scope opened onto a live session does not restore its tasks twice', async () => {
  const { cwd, store, session } = await createProject()
  const host = await bootstrap({ cwd, store, session, confirmMcpTrust: denyTrust })

  const restored: string[] = []
  host.backgroundTasks.restoreSession = async (sessionId: string) => {
    restored.push(sessionId)
    return []
  }
  // Registered tasks are how a scope recognises a session that is already live
  // in this process.
  host.backgroundTasks.getSnapshot = (sessionId: string) => (
    sessionId === session.id ? [{ id: 'task-1' }] : []
  ) as unknown as ReturnType<typeof host.backgroundTasks.getSnapshot>

  await host.openScope(session)

  assert.deepEqual(restored, [],
    'restoring again would double-register every background task the session owns')

  await host.shutdown('test over')
})

test('the project\'s startup diagnostics are surfaced once, by the initial scope', async () => {
  const { cwd, store, session } = await createProject({
    config: { ...MODEL_CONFIG, fallbackModel: 'typo-model' },
  })
  const host = await bootstrap({ cwd, store, session, confirmMcpTrust: denyTrust })

  assert.ok(host.diagnostics.some((diagnostic) => diagnostic.code === 'unknown_fallback_model'))

  const second: SessionScope = await host.openScope(await store.create('second tab'))
  assert.deepEqual(second.diagnostics, [],
    'a project warning shown once per tab would be shown once too often')

  await host.shutdown('test over')
})
