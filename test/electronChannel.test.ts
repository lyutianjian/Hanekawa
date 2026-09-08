import test from 'node:test'
import assert from 'node:assert/strict'
import type { IpcMain, IpcRenderer, WebContents } from 'electron'
import {
  ELECTRON_RUNTIME_CHANNEL,
  createElectronMainChannel,
  type MainIpcListener,
  type MainSideIpc,
  type MainSideTarget,
  type RendererSideIpc,
} from '../src/desktop/ipc/electronChannel.js'

/**
 * The main-side Electron transport.
 *
 * Two things are being tested, and the second one is why this file was
 * rewritten. The first is the `RuntimeChannel` contract over a mock ipc. The
 * second is that the structural interfaces actually describe **real Electron** —
 * the previous version of this suite had a mock that returned an unsubscriber
 * from `ipc.on` and exposed `addEventListener` on its target, so it cheerfully
 * satisfied two declarations that would have thrown on first launch. A mock can
 * only ever confirm it agrees with itself; the type-level guards below are what
 * pin the declarations to the API.
 *
 * The mock deliberately shares ONE `ipcMain` across targets, because that is
 * the real topology: `ipcMain` is process-wide and every renderer posts into
 * it. Giving each pane its own ipc (as the previous version did) makes the
 * `event.sender === target` filter unfalsifiable.
 */

// --- Drift guards: our structural types must be satisfied by real Electron ---
//
// Type-only imports, so no `electron` module is loaded in this plain-node test
// process. If Electron's signatures move, or someone "simplifies" one of our
// interfaces into something Electron does not implement, these stop compiling.
type Satisfied<Real, Ours> = Real extends Ours ? true : never

const ipcMainSatisfiesMainSideIpc: Satisfied<IpcMain, MainSideIpc> = true
const webContentsSatisfiesMainSideTarget: Satisfied<WebContents, MainSideTarget> = true
const ipcRendererSatisfiesRendererSideIpc: Satisfied<IpcRenderer, RendererSideIpc> = true

test('the structural Electron interfaces are satisfied by the real electron types', () => {
  // The compile-time assertions above are the real test; this keeps the
  // constants used so nothing prunes them, and states the intent out loud.
  assert.ok(ipcMainSatisfiesMainSideIpc)
  assert.ok(webContentsSatisfiesMainSideTarget)
  assert.ok(ipcRendererSatisfiesRendererSideIpc)
})

interface MockTarget extends MainSideTarget {
  /** Everything main posted to this renderer, in order. */
  readonly sent: unknown[]
  /** Simulate `webContents` being destroyed (window closed, renderer crash). */
  destroy(): void
  /** How many `'destroyed'` listeners are still attached. */
  destroyedListenerCount(): number
}

interface MockMain {
  readonly ipc: MainSideIpc
  /** A fresh `webContents`-shaped target. */
  createTarget(): MockTarget
  /** Simulate a renderer posting, stamped with the sender Electron would use. */
  pumpFromRenderer(sender: MainSideTarget, message: unknown): void
  /** How many listeners are on the runtime channel. */
  listenerCount(): number
}

function createMockMain(): MockMain {
  let listeners: MainIpcListener[] = []

  const ipc: MainSideIpc = {
    // Real `ipcMain.on` returns `this`, not an unsubscriber. The interface says
    // `void`, so a regression that tries to call the return value cannot even
    // be written — and this mock has nothing to hand back either.
    on(channel, listener) {
      if (channel !== ELECTRON_RUNTIME_CHANNEL) return
      listeners.push(listener)
    },
    removeListener(channel, listener) {
      if (channel !== ELECTRON_RUNTIME_CHANNEL) return
      listeners = listeners.filter((candidate) => candidate !== listener)
    },
  }

  const createTarget = (): MockTarget => {
    const sent: unknown[] = []
    let destroyedListeners: Array<() => void> = []
    const target: MockTarget = {
      sent,
      send(channel, ...args) {
        if (channel !== ELECTRON_RUNTIME_CHANNEL) return
        sent.push(args[0])
      },
      on(_event, listener) {
        destroyedListeners.push(listener)
      },
      removeListener(_event, listener) {
        destroyedListeners = destroyedListeners.filter((candidate) => candidate !== listener)
      },
      destroy() {
        for (const listener of [...destroyedListeners]) listener()
      },
      destroyedListenerCount: () => destroyedListeners.length,
    }
    return target
  }

  return {
    ipc,
    createTarget,
    pumpFromRenderer: (sender, message) => {
      for (const listener of [...listeners]) listener({ sender }, message)
    },
    listenerCount: () => listeners.length,
  }
}

test('a payload posted on the main channel reaches the bound renderer', () => {
  const mock = createMockMain()
  const target = mock.createTarget()
  const channel = createElectronMainChannel(mock.ipc, target)

  channel.post({ type: 'snapshot', value: 1 })
  assert.deepEqual(target.sent, [{ type: 'snapshot', value: 1 }])
})

test('a payload posted by the renderer reaches the main channel', () => {
  const mock = createMockMain()
  const target = mock.createTarget()
  const channel = createElectronMainChannel(mock.ipc, target)

  const seen: unknown[] = []
  channel.onMessage((message) => seen.push(message))

  mock.pumpFromRenderer(target, { type: 'hello', id: 'abc' })
  assert.deepEqual(seen, [{ type: 'hello', id: 'abc' }])
})

test('nested payloads cross intact', () => {
  const mock = createMockMain()
  const target = mock.createTarget()
  const channel = createElectronMainChannel(mock.ipc, target)

  const payload = {
    type: 'runtime-snapshot',
    snapshot: {
      modelKey: 'main',
      model: 'claude-3',
      effort: 'high',
      permissionMode: 'default' as const,
      contextWindow: 200_000,
    },
  }
  channel.post(payload)
  assert.deepEqual(target.sent, [payload])
})

test('a message from another pane is dropped, not delivered', () => {
  // The pane filter (`event.sender !== target`) is only meaningful because one
  // `ipcMain` serves every renderer: pane B's message really does arrive at
  // pane A's listener, and A has to reject it by sender identity.
  const mock = createMockMain()
  const targetA = mock.createTarget()
  const targetB = mock.createTarget()
  const channelA = createElectronMainChannel(mock.ipc, targetA)
  const channelB = createElectronMainChannel(mock.ipc, targetB)

  assert.equal(mock.listenerCount(), 2, 'both panes listen on the one shared ipcMain')

  const seenA: unknown[] = []
  const seenB: unknown[] = []
  channelA.onMessage((message) => seenA.push(message))
  channelB.onMessage((message) => seenB.push(message))

  mock.pumpFromRenderer(targetA, { tag: 'from-A' })
  mock.pumpFromRenderer(targetB, { tag: 'from-B' })

  assert.deepEqual(seenA, [{ tag: 'from-A' }], 'A must not see B traffic')
  assert.deepEqual(seenB, [{ tag: 'from-B' }], 'B must not see A traffic')
})

test('close() fires onClose exactly once, even when called repeatedly', () => {
  const mock = createMockMain()
  const channel = createElectronMainChannel(mock.ipc, mock.createTarget())

  let closeFires = 0
  channel.onClose(() => {
    closeFires++
  })
  channel.close()
  channel.close()
  channel.close()
  assert.equal(closeFires, 1)
})

test('close() detaches both listeners through removeListener', () => {
  // The teardown path that used to throw: `ipc.on`'s return value was called as
  // if it were an unsubscriber. `removeListener` is the API that exists, and
  // this asserts it actually ran rather than being merely reachable.
  const mock = createMockMain()
  const target = mock.createTarget()
  const channel = createElectronMainChannel(mock.ipc, target)
  assert.equal(mock.listenerCount(), 1)
  assert.equal(target.destroyedListenerCount(), 1)

  channel.close()

  assert.equal(mock.listenerCount(), 0, 'ipc listener must be removed')
  assert.equal(target.destroyedListenerCount(), 0, "'destroyed' listener must be removed")
})

test('after close(), inbound messages no longer reach handlers', () => {
  const mock = createMockMain()
  const target = mock.createTarget()
  const channel = createElectronMainChannel(mock.ipc, target)

  const seen: unknown[] = []
  channel.onMessage((message) => seen.push(message))

  mock.pumpFromRenderer(target, { n: 1 })
  channel.close()
  mock.pumpFromRenderer(target, { n: 2 })

  assert.deepEqual(seen, [{ n: 1 }])
})

test('after close(), post() is a silent drop', () => {
  const mock = createMockMain()
  const target = mock.createTarget()
  const channel = createElectronMainChannel(mock.ipc, target)

  channel.post({ id: 'a' })
  assert.equal(target.sent.length, 1)

  channel.close()
  channel.post({ id: 'b' })
  assert.equal(target.sent.length, 1, 'second post must not arrive')
})

test('a destroyed webContents closes the channel', () => {
  // This is the only teardown signal the main side gets when a window is closed
  // or a renderer crashes, and it is wired with `on('destroyed')` because a
  // `WebContents` is an EventEmitter — it has no `addEventListener`.
  const mock = createMockMain()
  const target = mock.createTarget()
  const channel = createElectronMainChannel(mock.ipc, target)

  let closeFires = 0
  channel.onClose(() => {
    closeFires++
  })

  target.destroy()
  assert.equal(closeFires, 1)

  channel.post({ dropped: true })
  assert.deepEqual(target.sent, [], 'a closed channel must not post')

  // Every close path detaches, not just an explicit `close()`. One shared
  // `ipcMain` plus a pane that died without cleaning up is a listener leak per
  // window for the life of the process.
  assert.equal(mock.listenerCount(), 0, 'a destroyed renderer must release its ipc listener')
})

test('close() after a destroy is harmless and fires nothing more', () => {
  const mock = createMockMain()
  const target = mock.createTarget()
  const channel = createElectronMainChannel(mock.ipc, target)

  let closeFires = 0
  channel.onClose(() => {
    closeFires++
  })

  target.destroy()
  channel.close()
  channel.close()

  assert.equal(closeFires, 1, 'close is idempotent across paths')
  assert.equal(mock.listenerCount(), 0)
  assert.equal(target.destroyedListenerCount(), 0)
})

test('unsubscribe returned by onMessage drops further deliveries', () => {
  const mock = createMockMain()
  const target = mock.createTarget()
  const channel = createElectronMainChannel(mock.ipc, target)

  const received: unknown[] = []
  const off = channel.onMessage((message) => received.push(message))

  mock.pumpFromRenderer(target, { a: 1 })
  assert.deepEqual(received, [{ a: 1 }])

  off()
  mock.pumpFromRenderer(target, { a: 2 })
  assert.deepEqual(received, [{ a: 1 }])
})

test('onClose handler fires synchronously when registered after close()', () => {
  const mock = createMockMain()
  const channel = createElectronMainChannel(mock.ipc, mock.createTarget())
  channel.close()

  let fired = 0
  channel.onClose(() => {
    fired++
  })
  assert.equal(fired, 1)
})

/**
 * Three-pane sender-filter stress test.
 *
 * The previous "two pane" test proves the filter rejects one other pane's
 * traffic. With three panes the asymmetry goes both ways: A must see only A,
 * B must see only B, C must see only C, and closing one pane must not affect
 * the others' deliveries. This is the layout the multi-tab desktop shell
 * will end up running, so the test covers every sender/observer pair.
 */
test('three panes share one ipcMain; each only sees its own traffic', () => {
  const mock = createMockMain()
  const targetA = mock.createTarget()
  const targetB = mock.createTarget()
  const targetC = mock.createTarget()

  const channelA = createElectronMainChannel(mock.ipc, targetA)
  const channelB = createElectronMainChannel(mock.ipc, targetB)
  const channelC = createElectronMainChannel(mock.ipc, targetC)

  assert.equal(mock.listenerCount(), 3, 'every pane installed a runtime listener')

  const seenA: unknown[] = []
  const seenB: unknown[] = []
  const seenC: unknown[] = []
  channelA.onMessage((message) => seenA.push(message))
  channelB.onMessage((message) => seenB.push(message))
  channelC.onMessage((message) => seenC.push(message))

  // Pump one message per pane in interleaved order; each observer should see
  // exactly the message tagged with its own sender.
  mock.pumpFromRenderer(targetA, { tag: 'A1' })
  mock.pumpFromRenderer(targetB, { tag: 'B1' })
  mock.pumpFromRenderer(targetC, { tag: 'C1' })
  mock.pumpFromRenderer(targetA, { tag: 'A2' })
  mock.pumpFromRenderer(targetB, { tag: 'B2' })

  assert.deepEqual(seenA, [{ tag: 'A1' }, { tag: 'A2' }])
  assert.deepEqual(seenB, [{ tag: 'B1' }, { tag: 'B2' }])
  assert.deepEqual(seenC, [{ tag: 'C1' }])

  // Closing pane B leaves A and C untouched. The shared ipcMain listener
  // for B is removed; A and C still get their traffic.
  channelB.close()
  assert.equal(mock.listenerCount(), 2, 'closing one pane removes only its listener')

  mock.pumpFromRenderer(targetA, { tag: 'A3' })
  mock.pumpFromRenderer(targetC, { tag: 'C2' })
  mock.pumpFromRenderer(targetB, { tag: 'B3 — should be dropped' })

  assert.deepEqual(seenA, [{ tag: 'A1' }, { tag: 'A2' }, { tag: 'A3' }])
  assert.deepEqual(seenB, [{ tag: 'B1' }, { tag: 'B2' }], 'B sees no traffic after close')
  assert.deepEqual(seenC, [{ tag: 'C1' }, { tag: 'C2' }])
})

test('the runtime channel name is the one literal both sides import', () => {
  assert.equal(ELECTRON_RUNTIME_CHANNEL, 'hanekawa:runtime')
})

test('image bytes survive the main channel as a Uint8Array', () => {
  // `import-attachment` is the one command whose payload is binary; real
  // `ipcRenderer.send` would structured-clone it, and the mock must carry the
  // same shape so the typed contract stays honest.
  const mock = createMockMain()
  const target = mock.createTarget()
  const channel = createElectronMainChannel(mock.ipc, target)

  const seen: unknown[] = []
  channel.onMessage((message) => seen.push(message))

  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
  mock.pumpFromRenderer(target, { type: 'import-attachment', id: '1', source: { kind: 'bytes', name: 'p.png', bytes } })

  assert.equal(seen.length, 1)
  const body = seen[0] as { source: { bytes: unknown } }
  assert.ok(body.source.bytes instanceof Uint8Array)
  assert.deepEqual([...(body.source.bytes as Uint8Array)], [...bytes])
})
