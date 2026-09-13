import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createElement as h } from 'react'
import { cleanup, render } from 'ink-testing-library'
import { App } from '../src/tui/components/App.js'
import { ClockProvider } from '../src/tui/clock/ClockContext.js'
import { bootstrap } from '../src/runtime/bootstrap.js'
import { createSessionPane } from '../src/runtime/sessionWorkspace.js'
import { SessionStore } from '../src/sessions/service.js'
import { AnthropicProvider } from '../src/config/providers/anthropicProvider.js'

test('TUI starts in setup, preserves an unsent draft, and sends after configuring its first model', async (t) => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'myagent-tui-startup-'))
  const testHome = await mkdtemp(path.join(tmpdir(), 'myagent-tui-home-'))
  const previousCwd = process.cwd()
  const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }
  process.env.HOME = testHome
  process.env.USERPROFILE = testHome
  process.chdir(cwd)
  t.after(() => {
    process.chdir(previousCwd)
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  const store = new SessionStore(cwd)
  await store.init()
  const session = store.createDraft()
  const host = await bootstrap({ cwd, store, session, confirmMcpTrust: async () => false })
  const pane = createSessionPane(host, host)
  t.after(async () => {
    cleanup()
    pane.close()
    await host.shutdown('test over')
  })
  const provider = t.mock.method(AnthropicProvider.prototype, 'createMessage', async () => ({
    content: 'TUI setup succeeded.',
    toolCalls: [],
    usage: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 0 },
  }))
  const screen = render(h(ClockProvider, null, h(App, {
    runtimeSlot: pane.runtimeSlot,
    sessionController: pane.controller,
    store,
    session,
    commands: host.commands,
    availableModelKeys: [],
    providerConfig: host.config,
    createRuntime: host.createRuntime,
    createActiveModelRuntime: host.createActiveModelRuntime,
    permissionGate: host.permissionGate,
    promptProxy: host.bridges.prompt,
    exitPlanProxy: host.bridges.exitPlan,
    enterPlanProxy: host.bridges.enterPlan,
    askUserQuestionProxy: host.bridges.askUserQuestion,
    existingRecords: [],
    backgroundTasks: host.backgroundTasks,
    attachments: host.attachments,
  })))
  const key = async (input: string) => {
    screen.stdin.write(input)
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  const frame = async (check: (text: string) => boolean) => {
    for (let i = 0; i < 100; i++) {
      if (check(screen.lastFrame() ?? '')) return
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.ok(check(screen.lastFrame() ?? ''), screen.lastFrame() ?? 'No TUI frame was rendered')
  }

  await frame((text) => text.includes('No endpoints configured'))
  await key('q')
  await frame((text) => !text.includes('Provider configuration'))
  await key('keep this draft')
  await key('\r')
  await frame((text) => text.includes('keep this draft') && text.includes('Failed to queue'))
  assert.equal(provider.mock.callCount(), 0)
  assert.deepEqual(await store.loadRecords(session.id), [])

  await key('\x15')
  await key('/provider')
  await key('\r')
  await frame((text) => text.includes('Provider configuration'))
  await key('n')
  await key('first')
  await key('\t')
  await key('\t')
  await key('\t')
  await key('test-key')
  await key('\r')
  await frame((text) => text.includes('Saved endpoint "first"'))
  assert.equal(pane.runtimeSlot.current, undefined)
  await key('\t')
  await key('n')
  await key('first-model')
  await key('\t')
  await key('remote-model')
  await key('\r')
  await frame((text) => text.includes('Saved model "first-model"'))
  assert.equal(pane.runtimeSlot.requireCurrent().modelKey, 'first-model')
  assert.equal(host.config.get().defaultModel, 'first-model')
  await key('q')
  await frame((text) => !text.includes('Provider configuration'))
  await key('hello after setup')
  await key('\r')
  await frame((text) => text.includes('TUI setup succeeded.'))
  assert.equal(provider.mock.callCount(), 1)
})
