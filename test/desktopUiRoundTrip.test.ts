import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createUiBridges } from '../src/runtime/bridges.js'
import { SessionHost } from '../src/runtime/protocol/host.js'
import { SessionClient } from '../src/runtime/protocol/client.js'
import { createMemoryChannelPair } from '../src/runtime/protocol/memoryChannel.js'
import {
  initialPermissionIndex,
  permissionKeyToIntent,
  permissionResponseFor,
  permissionViewModel,
} from '../src/desktop/renderer/model/permissionDialog.js'
import type { SessionController } from '../src/runtime/sessionController.js'
import type { RuntimeSlot } from '../src/runtime/runtimeSlot.js'
import type { ProjectRuntime, SessionScope } from '../src/runtime/types.js'
import type { PermissionRequest } from '../src/harness/permissions.js'
import type { Tool } from '../src/harness/types.js'

/**
 * The desktop permission flow, end to end, with only the view's DOM left out.
 *
 * A real `PermissionGate`-shaped request goes into a real `createUiBridges()`,
 * through a real `SessionHost`, across a channel that structured-clones every
 * message, into a real `SessionClient`, and is answered by the real renderer
 * view model. Everything the shipped renderer threw away — the diff preview, the
 * destructive analysis, the always-allow affordance — has to survive that trip.
 *
 * Two properties are load-bearing and cannot be checked in the pure model tests:
 * that `onAlwaysAllow` fires *before* the prompt promise resolves, and that a
 * handler which throws still answers rather than parking the agent loop.
 */

interface Harness {
  scope: SessionScope
  host: SessionHost
  client: SessionClient
  cwd: string
  /** Inputs the controller was actually asked to run, in order. */
  submits: string[]
  /** Flips the turn state and notifies, the way the real controller does. */
  setStreaming: (value: boolean) => void
  dispose: () => void
}

async function createHarness(): Promise<Harness> {
  const cwd = await mkdtemp(path.join(tmpdir(), 'myagent-desktop-ui-'))
  // A real file, so the preview is a genuine overwrite diff rather than a
  // create: `buildFileToolPreview` reads the disk through `defaultReadFile`.
  await writeFile(path.join(cwd, 'notes.txt'), 'alpha\nbeta\ngamma\n', 'utf8')

  const bridges = createUiBridges()
  const session = { id: 'ses', shortId: 'ses', title: 'round trip', messageCount: 0, updatedAt: 'now' }

  const scope = {
    session,
    bridges,
    permissionGate: {
      getMode: () => 'default',
      onModeChange: () => () => undefined,
    },
    promptSections: {},
    createRuntime: () => ({}),
    existingRecords: [],
    hasRecoverableInterruption: false,
    diagnostics: [],
    dispose: () => undefined,
  } as unknown as SessionScope

  const project = {
    cwd,
    config: {},
    // Only `appendRecord` is reached: the host's `MessageQueue` persists every
    // mutation as a `message_queue` record, which is exactly why the queue lives
    // host-side rather than in the renderer.
    store: { appendRecord: async () => undefined },
    backgroundTasks: { subscribe: () => () => undefined, getSnapshot: () => [] },
    mcp: { connected: [], failed: [] },
    initialModelKey: 'main',
    configuredEffortLevel: 'high',
    createActiveModelRuntime: () => ({}),
    shutdown: async () => undefined,
  } as unknown as ProjectRuntime

  const submits: string[] = []
  const snapshotListeners = new Set<() => void>()
  let streaming = false

  const controller = {
    onEvent: () => () => undefined,
    subscribe: (listener: () => void) => {
      snapshotListeners.add(listener)
      return () => snapshotListeners.delete(listener)
    },
    getSnapshot: () => ({
      isStreaming: streaming,
      // `total` is not nullable on `SessionUsage`; the real controller seeds it
      // with `createEmptySessionUsage()`, and the host reads it to derive the cost.
      usage: {
        total: { inputTokens: 0, cacheReadInputTokens: 0, outputTokens: 0 },
        lastRequest: null,
      },
      taskSnapshot: undefined,
      spinnerSubText: undefined,
    }),
    getSubagentProgress: () => new Map<string, string>(),
    submit: async (input: string) => { submits.push(input) },
  } as unknown as SessionController

  const runtimeSlot = {
    current: { modelKey: 'main', modelConfig: { model: 'fake' }, providerName: 'fake', loop: {}, planModeManager: {} },
    subscribe: () => () => undefined,
    getEffort: () => 'high',
  } as unknown as RuntimeSlot

  const [hostChannel, clientChannel] = createMemoryChannelPair()
  // The host reaches for a pane registry on every open-pane / close-pane /
  // list-panes command. Tests that do not exercise those commands get a
  // no-op registry; the host only touches the workspace on those three.
  const workspace = {
    list: () => [],
    paneForSession: () => undefined,
    open: async () => { throw new Error('open not used in this test') },
    adopt: () => { throw new Error('adopt not used in this test') },
    close: () => undefined,
  }
  const host = new SessionHost({
    channel: hostChannel,
    controller,
    runtimeSlot,
    project,
    scope,
    workspace,
    onPaneOpened: () => undefined,
    onPaneClosed: () => undefined,
  })
  const client = new SessionClient(clientChannel)

  return {
    scope,
    host,
    client,
    cwd,
    submits,
    setStreaming: (value: boolean) => {
      streaming = value
      for (const listener of [...snapshotListeners]) listener()
    },
    dispose: () => {
      host.dispose()
      client.dispose()
    },
  }
}

function tool(name: string, riskLevel: 'safe' | 'confirm' | 'dangerous'): Tool {
  return { name, riskLevel } as unknown as Tool
}

function writeRequest(overrides: Partial<PermissionRequest> = {}): PermissionRequest {
  return {
    tool: tool('Write', 'confirm'),
    input: { filePath: 'notes.txt', content: 'alpha\nBETA\ngamma\n' },
    reason: 'writing a file',
    source: 'mode',
    denialStreak: 0,
    ...overrides,
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

test('a file write reaches the renderer as a DTO carrying a real diff preview', async () => {
  const harness = await createHarness()
  let seen: unknown
  harness.client.setHandlers({
    permission: async (request) => {
      seen = request
      return { approved: true }
    },
  })

  const approved = await harness.scope.bridges.prompt.prompt(writeRequest())

  assert.equal(approved, true)
  const dto = seen as { toolName: string; preview?: { kind: string; oldText: string; newText: string } }
  assert.equal(dto.toolName, 'Write')
  assert.equal(dto.preview?.kind, 'diff', 'the host builds the preview; the renderer cannot')
  assert.equal(dto.preview?.oldText, 'alpha\nbeta\ngamma\n')

  // And the renderer's own model turns it into rows.
  const view = permissionViewModel({ request: seen as never, selectedIndex: 0 })
  assert.ok(view.preview?.kind === 'diff')
  assert.deepEqual(
    view.preview.rows.filter((row) => row.kind !== 'ctx').map((row) => [row.kind, row.text]),
    [['del', 'beta'], ['add', 'BETA']],
  )
  harness.dispose()
})

test('answering "always" fires onAlwaysAllow before the gate\'s promise resolves', async () => {
  const harness = await createHarness()
  const order: string[] = []

  harness.client.setHandlers({
    permission: async (request) => {
      // Exactly what the renderer does: derive the options, press "a", answer.
      const view = permissionViewModel({ request, selectedIndex: initialPermissionIndex(request) })
      const intent = permissionKeyToIntent({ key: 'a' }, { selectedIndex: view.selectedIndex, options: view.options })
      assert.equal(intent.kind, 'answer')
      assert.ok(intent.kind === 'answer')
      assert.equal(intent.action, 'always', 'the gate offered a rule, so always-allow is on the list')
      return permissionResponseFor(intent.action)
    },
  })

  const approved = await harness.scope.bridges.prompt.prompt(writeRequest({
    alwaysAllowRule: { toolName: 'Write', behavior: 'allow', source: 'session' },
    onAlwaysAllow: () => order.push('rule saved'),
  }))
  order.push('prompt resolved')

  assert.equal(approved, true)
  // `PermissionGate` reads the captured flag on the line after its await returns,
  // so the callback has to have run by then.
  assert.deepEqual(order, ['rule saved', 'prompt resolved'])
  harness.dispose()
})

test('a destructive command arrives with its warnings and no always-allow option', async () => {
  const harness = await createHarness()
  let seen: unknown
  harness.client.setHandlers({
    permission: async (request) => {
      seen = request
      const view = permissionViewModel({ request, selectedIndex: initialPermissionIndex(request) })
      // Deny is pre-selected, so plain Enter is the safe answer.
      const intent = permissionKeyToIntent({ key: 'Enter' }, { selectedIndex: view.selectedIndex, options: view.options })
      assert.ok(intent.kind === 'answer')
      return permissionResponseFor(intent.action)
    },
  })

  const approved = await harness.scope.bridges.prompt.prompt({
    tool: tool('Bash', 'confirm'),
    input: { command: 'rm -rf /tmp/whatever' },
    reason: 'shell command',
    source: 'mode',
    denialStreak: 1,
    alwaysAllowRule: { toolName: 'Bash', behavior: 'allow', source: 'session' },
    onAlwaysAllow: () => assert.fail('always-allow must not be reachable for a destructive command'),
  })

  assert.equal(approved, false, 'Enter on a destructive request denies')
  const dto = seen as { destructiveWarnings: unknown[]; denialStreak: number }
  assert.ok(dto.destructiveWarnings.length > 0, 'the host ran the shell analyzer')
  assert.equal(dto.denialStreak, 1)

  const view = permissionViewModel({ request: seen as never, selectedIndex: 0 })
  assert.deepEqual(view.options.map((option) => option.action), ['allow', 'deny'])
  assert.equal(view.tone, 'danger')
  assert.equal(view.denialStreakNote, 'Denied once already.')
  harness.dispose()
})

test('a renderer handler that throws still answers, so the loop is never parked', async () => {
  const harness = await createHarness()
  harness.client.setHandlers({
    permission: async () => { throw new Error('the dialog blew up') },
  })

  // Nothing else releases this: `PermissionGate.approve` has no timeout, and
  // `ToolRunner.run` does not pass its abort signal into it.
  const approved = await harness.scope.bridges.prompt.prompt(writeRequest())
  assert.equal(approved, false, 'the permission fallback is denial')

  harness.client.setHandlers({
    enterPlan: async () => { throw new Error('the dialog blew up') },
  })
  // The asymmetry survives: entering plan mode only restricts the agent.
  assert.equal(await harness.scope.bridges.enterPlan.open(), true)
  harness.dispose()
})

test('several prompts queue, and each resolves with its own answer', async () => {
  const harness = await createHarness()
  const seen: string[] = []
  harness.client.setHandlers({
    permission: async (request) => {
      seen.push(String((request.input as { filePath?: string }).filePath))
      return { approved: (request.input as { filePath?: string }).filePath === 'first.txt' }
    },
  })

  const first = harness.scope.bridges.prompt.prompt(writeRequest({ input: { filePath: 'first.txt', content: 'a' } }))
  const second = harness.scope.bridges.prompt.prompt(writeRequest({ input: { filePath: 'second.txt', content: 'b' } }))
  await settle()

  assert.deepEqual(await Promise.all([first, second]), [true, false])
  assert.deepEqual(seen, ['first.txt', 'second.txt'])
  harness.dispose()
})

test('the whole DTO survives structured clone, preview included', async () => {
  const harness = await createHarness()
  let seen: unknown
  harness.client.setHandlers({
    permission: async (request) => {
      seen = request
      return { approved: false }
    },
  })

  // The memory channel clones on every post, so getting here at all proves it —
  // Electron's IPC would throw on a live object and `child_process.send` would
  // silently drop a function.
  await harness.scope.bridges.prompt.prompt(writeRequest())
  assert.doesNotThrow(() => structuredClone(seen))
  assert.equal(JSON.stringify(seen).includes('"execute"'), false, 'no Tool crossed the boundary')
  harness.dispose()
})

/**
 * The mid-turn Enter path, end to end with only the DOM left out.
 *
 * The model layer cannot cover this: `keymap.ts` decides that the keystroke means
 * "queue", but whether the message actually survives the round trip, appears in
 * the strip and is sent afterwards depends on the host owning the queue, on
 * `PersistedQueuedMessage` being clone-safe, and on the pump firing off the
 * snapshot publish that ends the turn.
 */
test('a message queued mid-turn crosses the boundary, shows up, and is sent when the turn ends', async () => {
  const harness = await createHarness()
  const announced: string[][] = []
  harness.client.onQueueChanged((messages) => {
    announced.push(messages.map((message) => message.content))
  })

  harness.setStreaming(true)
  // What `resolveKey` returning `'enqueue'` leads to in `app.ts`.
  const stored = await harness.client.enqueueMessage('the next thing')

  assert.equal(stored.content, 'the next thing')
  assert.equal(stored.priority, 'next')
  assert.doesNotThrow(() => structuredClone(stored))

  await settle()
  assert.deepEqual(harness.client.getQueuedMessages().map((entry) => entry.content), ['the next thing'])
  // This is what the strip draws from; `queuedMessagesView` turns it into rows.
  assert.deepEqual(announced.at(0), ['the next thing'])
  assert.deepEqual(harness.submits, [], 'and nothing was sent while the turn ran')

  harness.setStreaming(false)
  await settle()

  assert.deepEqual(harness.submits, ['the next thing'], 'the turn ending is what releases it')
  assert.deepEqual(harness.client.getQueuedMessages(), [], 'and the strip empties')
  assert.deepEqual(announced.at(-1), [])
  harness.dispose()
})

test('clearing the queue reaches the host and empties the strip', async () => {
  const harness = await createHarness()
  harness.setStreaming(true)
  await harness.client.enqueueMessage('never mind')
  await settle()
  assert.equal(harness.client.getQueuedMessages().length, 1)

  // The Clear button in `dom/queueView.ts`.
  await harness.client.clearQueue()
  await settle()

  assert.deepEqual(harness.client.getQueuedMessages(), [])
  harness.setStreaming(false)
  await settle()
  assert.deepEqual(harness.submits, [], 'a cleared message must not surface later')
  harness.dispose()
})
