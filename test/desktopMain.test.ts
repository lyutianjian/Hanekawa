import test from 'node:test'
import assert from 'node:assert/strict'
import { createUiBridges } from '../src/runtime/bridges.js'
import { CommandRegistry } from '../src/commands/registry.js'
import { SessionHost } from '../src/runtime/protocol/host.js'
import { SessionClient } from '../src/runtime/protocol/client.js'
import type { RuntimeChannel } from '../src/runtime/protocol/channel.js'
import type { SessionController } from '../src/runtime/sessionController.js'
import type { RuntimeSlot } from '../src/runtime/runtimeSlot.js'
import type { ProjectRuntime, SessionScope } from '../src/runtime/types.js'
import type { SessionPane } from '../src/runtime/sessionWorkspace.js'
import type { SessionMeta } from '../src/sessions/service.js'
import { createMemoryChannelPair } from '../src/runtime/protocol/memoryChannel.js'
import {
  createElectronMainChannel,
  ELECTRON_RUNTIME_CHANNEL,
  type MainIpcListener,
  type MainSideIpc,
  type MainSideTarget,
} from '../src/desktop/ipc/electronChannel.js'
import {
  createBridgeChannel,
  type BridgeWindow,
} from '../src/desktop/renderer/bridgeChannel.js'
import type { DesktopBridge } from '../src/desktop/types.js'

/**
 * End-to-end smoke for the desktop stack without launching Electron.
 *
 * Both halves are the adapters that actually ship: `createElectronMainChannel`
 * over a mock `ipcMain`/`webContents`, and `createBridgeChannel` over a mock
 * `contextBridge` bridge. They are wired back-to-back into a `SessionHost` and
 * a `SessionClient` and driven through one `hello` round trip, so the
 * `WireHelloResult` payload crosses the pair in both directions.
 *
 * Why not stub `electron` and import `main.ts`: the main entry calls
 * `app.requestSingleInstanceLock()` at module top level, so under plain node
 * (where `require('electron')` yields a path string and `app` is `undefined`)
 * importing it throws before any test runs. Driving channel+host+client
 * directly is what has coverage value anyway.
 */

function createPair(): { main: RuntimeChannel; renderer: RuntimeChannel } {
  let mainListeners: MainIpcListener[] = []
  let bridgeHandlers: Array<(event: unknown) => void> = []

  // Main → renderer: `webContents.send` lands on whoever the preload bridge has
  // subscribed.
  const target: MainSideTarget = {
    send(channel, ...args) {
      if (channel !== ELECTRON_RUNTIME_CHANNEL) return
      for (const handler of [...bridgeHandlers]) handler(args[0])
    },
    on() {
      // Lifecycle is irrelevant to a round-trip test; `electronChannel.test.ts`
      // covers `'destroyed'`.
    },
    removeListener() {},
  }

  const mainIpc: MainSideIpc = {
    on(channel, listener) {
      if (channel !== ELECTRON_RUNTIME_CHANNEL) return
      mainListeners.push(listener)
    },
    removeListener(channel, listener) {
      if (channel !== ELECTRON_RUNTIME_CHANNEL) return
      mainListeners = mainListeners.filter((candidate) => candidate !== listener)
    },
  }

  // Renderer → main: every message arrives stamped with the `webContents` that
  // sent it, which is what the host-side pane filter checks.
  const bridge: DesktopBridge = {
    send(message) {
      for (const listener of [...mainListeners]) listener({ sender: target }, message)
    },
    onMessage(handler) {
      bridgeHandlers.push(handler)
      return () => {
        bridgeHandlers = bridgeHandlers.filter((candidate) => candidate !== handler)
      }
    },
    close() {},
  }

  const rendererWindow: BridgeWindow = {
    addEventListener() {},
    removeEventListener() {},
  }

  return {
    main: createElectronMainChannel(mainIpc, target),
    renderer: createBridgeChannel(bridge, rendererWindow),
  }
}

function fakeController(): SessionController {
  return {
    onEvent: () => () => undefined,
    subscribe: () => () => undefined,
    getSnapshot: () => ({
      isStreaming: false,
      // `total` is not nullable on `SessionUsage`, and the real controller
      // initializes it with `createEmptySessionUsage()`. It used to be `null`
      // here, which only compiled because this whole object is cast — and the
      // host now reads it to derive the session cost.
      usage: { total: { inputTokens: 0, cacheReadInputTokens: 0, outputTokens: 0 }, lastRequest: null },
      taskSnapshot: undefined,
      spinnerSubText: undefined,
    }),
    getSubagentProgress: () => new Map<string, string>(),
    reload: async () => [],
    submit: async () => undefined,
    interrupt: () => undefined,
    getCheckpointService: () => ({
      getCheckpointsWithDiffs: async () => [],
      restoreToCommit: async () => ({ success: true }),
    }),
    getSessionMeta: () => ({
      id: 'ses',
      shortId: 'ses',
      title: 'fixture',
      messageCount: 0,
      updatedAt: 0,
    }),
  } as unknown as SessionController
}

function fakeRuntimeSlot(): RuntimeSlot {
  return {
    current: {
      modelKey: 'main',
      modelConfig: { model: 'fake', contextWindow: 200_000 },
      providerName: 'fake',
      loop: {
        runTool: async () => ({ ok: true, content: '' }),
        clearCachedSections: () => undefined,
        invalidateRecordsCache: () => undefined,
        summarizeRecordsForRewind: async () => ({ summary: '', index: 0 }),
      },
      planModeManager: {} as never,
    },
    subscribe: () => () => undefined,
    getEffort: () => 'high',
    replace: () => undefined,
    setEffort: (level: string) => level,
    reapplyEffort: () => 'high',
    dispose: () => undefined,
  } as unknown as RuntimeSlot
}

function fakeScope(): SessionScope {
  return {
    session: {
      id: 'ses',
      shortId: 'ses',
      title: 'fixture',
      messageCount: 0,
      updatedAt: 0,
    },
    bridges: createUiBridges(),
    permissionGate: {
      getMode: () => 'default',
      setConfigRules: () => undefined,
      onModeChange: () => () => undefined,
    } as never,
    promptSections: {} as never,
    createRuntime: () => ({} as never),
    existingRecords: [],
    hasRecoverableInterruption: false,
    diagnostics: [],
    dispose: () => undefined,
  } as unknown as SessionScope
}

function fakeProject(): ProjectRuntime {
  return {
    cwd: '/tmp/fixture',
    config: {} as never,
    // Real, because `ProjectRuntime.commands` is what the host resolves slash
    // commands through and the cast at the bottom of this function would hide
    // a missing one until something actually ran `/help`.
    commands: new CommandRegistry(),
    store: {
      createDraft: (title?: string) => ({
        id: `draft-${Math.random().toString(36).slice(2)}`,
        shortId: 'draft',
        title,
        messageCount: 0,
        updatedAt: 0,
      }),
      resolve: async (idOrPrefix: string) => ({
        id: idOrPrefix,
        shortId: idOrPrefix.slice(0, 4),
        title: 'found',
        messageCount: 0,
        updatedAt: 0,
      }),
      loadRecordsWithDiagnostics: async () => ({ records: [], diagnostics: [] }),
    } as never,
    backgroundTasks: {
      subscribe: () => () => undefined,
      getSnapshot: () => [],
      peekOutput: () => '',
      killShell: async () => undefined,
      restoreSession: async () => [],
    } as never,
    mcp: { connected: [], failed: [] },
    initialModelKey: 'main',
    initialEffort: undefined,
    configuredEffortLevel: 'high',
    createActiveModelRuntime: () => ({} as never),
    openScope: async () => fakeScope(),
    reloadAgentDefinitions: async () => 0,
    reloadSkills: async () => 0,
    reloadSettings: async () => ({ needsRuntimeRebuild: false }),
    shutdown: async () => undefined,
  } as unknown as ProjectRuntime
}

test('SessionHost and SessionClient over the electron-shaped channel exchange hello and reply', async () => {
  const pair = createPair()

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
    channel: pair.main,
    controller: fakeController(),
    runtimeSlot: fakeRuntimeSlot(),
    project: fakeProject(),
    scope: fakeScope(),
    workspace,
    onPaneOpened: () => undefined,
    onPaneClosed: () => undefined,
  })
  const client = new SessionClient(pair.renderer)

  try {
    const hello = await client.hello()
    // The hello result must round-trip the configured session through the
    // structured-clone boundary twice (command → main, reply → renderer).
    assert.equal(hello.sessionId, 'ses')
    assert.equal(hello.session.id, 'ses')
    assert.equal(hello.cwd, '/tmp/fixture')
    assert.deepEqual(hello.records, [])
    assert.deepEqual(hello.notices, [])
    assert.equal(hello.hasRecoverableInterruption, false)
    assert.equal(hello.configuredEffortLevel, 'high')
  } finally {
    host.dispose()
    client.dispose()
  }
})

/**
 * Multi-pane round trip.
 *
 * Two `SessionHost`s share one workspace; each has its own channel and its own
 * `SessionClient`. The point is the workspace is the shared registry: pane
 * A's `open-pane` lands in the registry, pane B's `list-panes` sees the new
 * pane, and pane A's `close-pane` removes it again. The sender-filter test for
 * the Electron-shaped channel lives in `electronChannel.test.ts`.
 *
 * `createMemoryChannelPair()` is load-bearing here: a real cross-pane scenario
 * is two hosts talking to two renderers, not one host talking to two
 * renderers. The pair-per-host model also matches the production layout
 * exactly — one `SessionHost` per pane, one `SessionClient` per renderer.
 */
test('two panes over a shared workspace exchange open / list / close', async () => {
  const panes = new Map<string, SessionPane>()
  function fakePane(meta: SessionMeta): SessionPane {
    return { getSession: () => meta } as unknown as SessionPane
  }

  const workspace = {
    list: () => [...panes.values()],
    paneForSession: (sessionId: string) => panes.get(sessionId),
    open: async (session: SessionMeta) => {
      panes.set(session.id, fakePane(session))
      return panes.get(session.id)!
    },
    adopt: (scope: SessionScope) => {
      panes.set(scope.session.id, fakePane(scope.session))
      return panes.get(scope.session.id)!
    },
    close: (pane: SessionPane) => {
      panes.delete(pane.getSession().id)
    },
  }

  // Seed both panes up front. `a` is the bootstrap one; `b` is a second pane
  // opened before the test starts, so `open-pane` from `a` resolves to a
  // third.
  const bootstrapSession: SessionMeta = { id: 'ses-a', shortId: 'sa', title: 'pane-a', createdAt: '0', updatedAt: '0', messageCount: 0 }
  const secondSession: SessionMeta = { id: 'ses-b', shortId: 'sb', title: 'pane-b', createdAt: '0', updatedAt: '0', messageCount: 0 }
  panes.set(bootstrapSession.id, fakePane(bootstrapSession))
  panes.set(secondSession.id, fakePane(secondSession))

  const openedCallbacks: string[] = []
  const closedCallbacks: string[] = []

  const [hostAChannel, clientAChannel] = createMemoryChannelPair()
  const [hostBChannel, clientBChannel] = createMemoryChannelPair()

  const hostA = new SessionHost({
    channel: hostAChannel,
    controller: fakeController(),
    runtimeSlot: fakeRuntimeSlot(),
    project: fakeProject(),
    scope: { ...fakeScope(), session: bootstrapSession },
    workspace,
    onPaneOpened: (pane) => openedCallbacks.push(pane.getSession().id),
    onPaneClosed: (paneId) => closedCallbacks.push(paneId),
  })
  const hostB = new SessionHost({
    channel: hostBChannel,
    controller: fakeController(),
    runtimeSlot: fakeRuntimeSlot(),
    project: fakeProject(),
    scope: { ...fakeScope(), session: secondSession },
    workspace,
    onPaneOpened: () => undefined,
    onPaneClosed: () => undefined,
  })

  const clientA = new SessionClient(clientAChannel)
  const clientB = new SessionClient(clientBChannel)

  try {
    // Two hello calls, two different sessions, on independent channels.
    const [helloA, helloB] = await Promise.all([clientA.hello(), clientB.hello()])
    assert.equal(helloA.session.id, 'ses-a')
    assert.equal(helloB.session.id, 'ses-b')

    // Both clients see the same shared workspace topology.
    const listA = await clientA.listPanes()
    const listB = await clientB.listPanes()
    assert.deepEqual(listA.map((p) => p.sessionId), ['ses-a', 'ses-b'])
    assert.deepEqual(listB.map((p) => p.sessionId), ['ses-a', 'ses-b'])

    // `open-pane` from pane A with no args mints a fresh draft. The host
    // adopts a new scope, calls `onPaneOpened`, and replies with the new
    // session id. The third pane shows up in subsequent list-panes calls.
    const opened = await clientA.openPane({})
    assert.ok(opened.paneId, 'open-pane returns the new pane id')
    assert.equal(openedCallbacks.length, 1, 'the open-pane callback fires once')
    assert.equal(openedCallbacks[0], opened.session.id)

    const listAfter = await clientA.listPanes()
    assert.equal(listAfter.length, 3)

    // `close-pane` looks the pane up by id and runs the registry's teardown.
    // The callback fires once; the pane disappears from list-panes.
    await clientA.closePane(opened.paneId)
    assert.deepEqual(closedCallbacks, [opened.paneId])
    const listFinal = await clientA.listPanes()
    assert.equal(listFinal.length, 2)
  } finally {
    hostA.dispose()
    hostB.dispose()
    clientA.dispose()
    clientB.dispose()
  }
})

/**
 * `paneId` is the controller's current session id, which moves on `/clear`
 * and `/resume`. The host's pane lookup must reflect the new id, and the
 * shell's `close-pane` must find the pane by the *current* id (not whichever
 * id the pane originally opened with).
 *
 * This is the assertion behind `main.ts`'s "index by window id, not session
 * id" decision: the host stays indexed by session id (one pane per session,
 * the workspace's invariant) and the session id is whatever the controller
 * currently shows — a stale cached id would silently break Ctrl+W after
 * `/clear`.
 */
test('paneId follows the controller across /clear and close-pane still resolves', async () => {
  const panes = new Map<string, SessionPane>()
  function fakePane(meta: SessionMeta): SessionPane {
    return { getSession: () => meta } as unknown as SessionPane
  }

  const workspace = {
    list: () => [...panes.values()],
    paneForSession: (sessionId: string) => {
      for (const pane of panes.values()) {
        if (pane.getSession().id === sessionId) return pane
      }
      return undefined
    },
    open: async (session: SessionMeta) => {
      const pane = livePane()
      panes.set(session.id, pane)
      return pane
    },
    adopt: (scope: SessionScope) => {
      const pane = livePane()
      panes.set(scope.session.id, pane)
      return pane
    },
    // Drop by reference, not by the (now-moving) session id — this is what
    // SessionWorkspace.close does in production.
    close: (pane: SessionPane) => {
      for (const [key, value] of panes.entries()) {
        if (value === pane) panes.delete(key)
      }
    },
  }

  const initialSession: SessionMeta = {
    id: 'ses-original',
    shortId: 'orig',
    title: 'before /clear',
    createdAt: '0',
    updatedAt: '0',
    messageCount: 0,
  }
  const clearedSession: SessionMeta = {
    id: 'ses-after-clear',
    shortId: 'new',
    title: 'after /clear',
    createdAt: '0',
    updatedAt: '0',
    messageCount: 0,
  }

  // Mutable session on the controller — what `retarget` does in `sessionSwitch.ts`.
  let currentSession: SessionMeta = initialSession
  const controller = {
    ...fakeController(),
    getSessionMeta: () => currentSession,
  }
  // The fake pane is what `collectPanes` reads through — it must follow the
  // controller, not a stored snapshot. `SessionPane.getSession` derives
  // from the controller for exactly this reason.
  function livePane(): SessionPane {
    return { getSession: () => controller.getSessionMeta() } as unknown as SessionPane
  }

  const closedCallbacks: string[] = []
  const [hostChannel, clientChannel] = createMemoryChannelPair()
  const host = new SessionHost({
    channel: hostChannel,
    controller: controller as unknown as SessionController,
    runtimeSlot: fakeRuntimeSlot(),
    project: fakeProject(),
    scope: { ...fakeScope(), session: initialSession },
    workspace,
    onPaneOpened: () => undefined,
    onPaneClosed: (paneId) => closedCallbacks.push(paneId),
  })
  const client = new SessionClient(clientChannel)

  try {
    panes.set(initialSession.id, livePane())

    // Before /clear: the pane id is the original session id.
    const before = await client.listPanes()
    assert.deepEqual(before.map((p) => p.paneId), ['ses-original'])

    // Simulate /clear: the controller now reports a fresh draft.
    currentSession = clearedSession

    // After /clear: the pane id reflects the controller's current session.
    // The host did not re-mint any pane — it is the same pane, bound to the
    // same controller, which now points at a new session.
    const after = await client.listPanes()
    assert.deepEqual(
      after.map((p) => p.paneId),
      ['ses-after-clear'],
      'paneId follows the controller across /clear',
    )

    // The renderer can still close the pane using the new id. The host's
    // `handleClosePane` looks the pane up by `command.paneId` against the
    // workspace, which scans the live controllers and finds the moved id.
    await client.closePane('ses-after-clear')
    assert.deepEqual(closedCallbacks, ['ses-after-clear'])
    const final = await client.listPanes()
    assert.equal(final.length, 0)
  } finally {
    host.dispose()
    client.dispose()
  }
})
