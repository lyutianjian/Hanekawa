import test from 'node:test'
import assert from 'node:assert/strict'
import { createLaneMux, LANE_UNATTACHED_BUFFER_LIMIT } from '../src/runtime/protocol/laneChannel.js'
import { createMemoryChannelPair } from '../src/runtime/protocol/memoryChannel.js'

/**
 * The lane multiplexer: one transport, many `RuntimeChannel` views.
 *
 * Everything here is driven through a memory pair, which matters for more than
 * convenience — `structuredClone` runs on every `post`, so a lane frame that
 * could not survive real IPC fails in this room, and the microtask delivery
 * makes ordering assertions meaningful.
 *
 * The two invariants with teeth, both born from the single-window design:
 *
 * - **The close control frame.** `SessionHost.dispose()` does not close the
 *   channel, so when the shell retires a lane the *peer's* view must learn
 *   about it through a frame — that close is what releases the renderer's
 *   pending requests. A mux that only closed its own side would strand them.
 * - **The bounded pre-attach buffer.** A lane's first frames routinely arrive
 *   before the other side has called `lane(key)`. One lost `reply` hangs its
 *   pending request forever, so the buffer drains whole and in order — and a
 *   lane that overflows it closes rather than dropping frames piecemeal.
 */

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

interface MuxPair {
  /** The main-side mux. */
  main: ReturnType<typeof createLaneMux>
  /** The renderer-side mux. */
  renderer: ReturnType<typeof createLaneMux>
  /** Raw transport ends, for observing envelope frames below the mux layer. */
  mainTransport: ReturnType<typeof createMemoryChannelPair>[0]
  rendererTransport: ReturnType<typeof createMemoryChannelPair>[0]
}

function createMuxPair(): MuxPair {
  const [mainTransport, rendererTransport] = createMemoryChannelPair()
  const pair: MuxPair = {
    main: createLaneMux(mainTransport),
    renderer: createLaneMux(rendererTransport),
    mainTransport,
    rendererTransport,
  }
  return pair
}

/** Every envelope frame that crossed the wire, per direction. */
function observeFrames(pair: MuxPair): { mainToRenderer: unknown[]; rendererToMain: unknown[] } {
  const mainToRenderer: unknown[] = []
  const rendererToMain: unknown[] = []
  pair.rendererTransport.onMessage((frame) => mainToRenderer.push(frame))
  pair.mainTransport.onMessage((frame) => rendererToMain.push(frame))
  return { mainToRenderer, rendererToMain }
}

test('data frames reach their own lane only', async () => {
  const pair = createMuxPair()
  const laneOne = pair.renderer.lane('1')
  const laneTwo = pair.renderer.lane('2')
  const one: unknown[] = []
  const two: unknown[] = []
  laneOne.onMessage((body) => one.push(body))
  laneTwo.onMessage((body) => two.push(body))

  pair.main.lane('1').post({ hello: 'one' })
  await settle()

  assert.deepEqual(one, [{ hello: 'one' }])
  assert.deepEqual(two, [])
})

test('lane() hands out the same view while the lane is open', () => {
  const pair = createMuxPair()
  assert.equal(pair.main.lane('1'), pair.main.lane('1'))
  assert.equal(pair.renderer.lane('1'), pair.renderer.lane('1'))
})

test('closeLane fires onClose once on each side, posts one control frame, and does not echo', async () => {
  const pair = createMuxPair()
  const frames = observeFrames(pair)
  const mainCloses: string[] = []
  const rendererCloses: string[] = []
  pair.main.lane('1').onClose(() => mainCloses.push('main'))
  pair.renderer.lane('1').onClose(() => rendererCloses.push('renderer'))

  pair.main.closeLane('1')
  await settle()

  assert.deepEqual(mainCloses, ['main'])
  assert.deepEqual(rendererCloses, ['renderer'])
  const closeFrames = frames.mainToRenderer.filter(
    (frame) => (frame as { kind?: string }).kind === 'close',
  )
  assert.equal(closeFrames.length, 1)
  assert.equal(frames.rendererToMain.length, 0, 'a remote close must not be echoed')

  // Posting into a closed lane drops silently — the RuntimeChannel contract —
  // and a late close subscriber learns the lane is gone immediately.
  assert.doesNotThrow(() => pair.main.lane('1').post({ late: true }))
  const lateCloses: string[] = []
  pair.renderer.lane('1').onClose(() => lateCloses.push('late'))
  assert.deepEqual(lateCloses, ['late'])
})

test('closeLane is idempotent: the second call sends nothing and fires nothing', async () => {
  const pair = createMuxPair()
  const frames = observeFrames(pair)
  let rendererCloses = 0
  pair.renderer.lane('1').onClose(() => {
    rendererCloses += 1
  })

  pair.main.closeLane('1')
  pair.main.closeLane('1')
  await settle()

  assert.equal(rendererCloses, 1)
  assert.equal(frames.mainToRenderer.length, 1)
})

test('frames that arrive before attach are buffered and drain in order', async () => {
  const pair = createMuxPair()
  // The renderer has never called lane('1'); the main side posts anyway.
  pair.main.lane('1').post({ n: 1 })
  pair.main.lane('1').post({ n: 2 })
  pair.main.lane('1').post({ n: 3 })
  await settle()

  const received: unknown[] = []
  pair.renderer.lane('1').onMessage((body) => received.push(body))
  await settle()

  assert.deepEqual(received, [{ n: 1 }, { n: 2 }, { n: 3 }])
})

test('a lane that overflows the pre-attach buffer closes on both sides', async () => {
  const pair = createMuxPair()
  const mainCloses: string[] = []
  const rendererCloses: string[] = []
  pair.main.lane('2').onClose(() => mainCloses.push('main'))
  pair.renderer.lane('2').onClose(() => rendererCloses.push('renderer'))

  for (let n = 0; n <= LANE_UNATTACHED_BUFFER_LIMIT; n += 1) {
    pair.main.lane('2').post({ n })
  }
  await settle()

  // The receiving side closed first (its buffer overflowed) and told the
  // sender via a control frame; both lanes are now dead.
  assert.deepEqual(rendererCloses, ['renderer'])
  assert.deepEqual(mainCloses, ['main'])

  // Nothing was delivered piecemeal — the lane died before any attach.
  const received: unknown[] = []
  pair.renderer.lane('2').onMessage((body) => received.push(body))
  await settle()
  assert.deepEqual(received, [])
})

test('transport death closes every lane on both sides, attached or not', async () => {
  const pair = createMuxPair()
  const closes: string[] = []
  pair.main.lane('1').onClose(() => closes.push('main:1'))
  pair.renderer.lane('1').onClose(() => closes.push('renderer:1'))
  // Lane 2 has no renderer-side view yet; one buffered frame creates it there.
  pair.main.lane('2').post({ n: 1 })
  await settle()
  pair.main.lane('2').onClose(() => closes.push('main:2'))
  pair.renderer.lane('2').onClose(() => closes.push('renderer:2'))

  pair.mainTransport.close()
  await settle()

  assert.deepEqual([...closes].sort(), ['main:1', 'main:2', 'renderer:1', 'renderer:2'])

  // A lane minted after the death is born closed, and posting is a no-op.
  const zombie = pair.main.lane('3')
  const zombieCloses: string[] = []
  zombie.onClose(() => zombieCloses.push('zombie'))
  assert.deepEqual(zombieCloses, ['zombie'])
  assert.doesNotThrow(() => zombie.post({ late: true }))
})

test('mux.close() retires every lane and the transport', async () => {
  const pair = createMuxPair()
  const closes: string[] = []
  pair.main.lane('1').onClose(() => closes.push('main:1'))
  pair.renderer.lane('1').onClose(() => closes.push('renderer:1'))
  pair.main.lane('2').onClose(() => closes.push('main:2'))
  pair.renderer.lane('2').onClose(() => closes.push('renderer:2'))

  pair.main.close()
  await settle()

  // The peer learns through the transport close, not through per-lane frames.
  assert.deepEqual([...closes].sort(), ['main:1', 'main:2', 'renderer:1', 'renderer:2'])
})

test('closing a lane the peer never saw still plants a tombstone there', async () => {
  const pair = createMuxPair()
  const frames = observeFrames(pair)

  pair.main.closeLane('ghost')
  await settle()

  // The renderer mux now knows 'ghost' is closed; attaching later must not
  // pretend the lane is alive and buffer forever.
  const lateCloses: string[] = []
  pair.renderer.lane('ghost').onClose(() => lateCloses.push('late'))
  assert.deepEqual(lateCloses, ['late'])
  // And no echo came back for the tombstone.
  assert.equal(frames.rendererToMain.length, 0)
})

test('malformed frames are dropped without disturbing live lanes', async () => {
  const pair = createMuxPair()
  const received: unknown[] = []
  pair.renderer.lane('1').onMessage((body) => received.push(body))

  pair.mainTransport.post('not-a-frame')
  pair.mainTransport.post({ kind: 'data' })
  pair.mainTransport.post({ kind: 'bogus', lane: '1' })
  pair.mainTransport.post(null)
  pair.main.lane('1').post({ real: true })
  await settle()

  assert.deepEqual(received, [{ real: true }])
})

test('a body that cannot be cloned fails loudly rather than vanishing', () => {
  const pair = createMuxPair()
  assert.throws(() => pair.main.lane('1').post({ fn: () => {} }))
})

test('image bytes cross a lane as a Uint8Array, intact', async () => {
  const pair = createMuxPair()
  const rendererLane = pair.renderer.lane('7')
  const seen: unknown[] = []
  pair.main.lane('7').onMessage((body) => seen.push(body))

  // An `import-attachment`-shaped body: every post runs structuredClone, so a
  // byte buffer that could not survive real IPC fails here, in this room.
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
  rendererLane.post({ type: 'import-attachment', id: '1', source: { kind: 'bytes', name: 'p.png', bytes } })
  await settle()

  assert.equal(seen.length, 1)
  const body = seen[0] as { source: { bytes: Uint8Array } }
  assert.ok(body.source.bytes instanceof Uint8Array, 'the clone kept it a Uint8Array')
  assert.deepEqual([...body.source.bytes], [...bytes])
})
