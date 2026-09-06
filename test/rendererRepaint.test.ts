import test from 'node:test'
import assert from 'node:assert/strict'
import { createRepaint, type Scheduler } from '../src/desktop/renderer/frame.js'

/**
 * The frame coalescer behind the two repaints a streaming turn drives.
 *
 * The contract it has to keep is narrow but load-bearing: a paint asked for out
 * of an idle beat must land *in the same tick*, because `paneSession.ts` has
 * call sites that hand focus to a node the paint had to have built, and the boot
 * sequence asserts the sidebar has content the moment it returns. Everything
 * after that first paint is what the fix is for — a chunk arriving per streamed
 * token must cost at most one paint per frame.
 */

/** A hand-driven scheduler: `run()` is the frame boundary. */
function fakeFrames(): { schedule: Scheduler; run: () => void; pending: () => number } {
  let queue: Array<() => void> = []
  return {
    schedule: (callback) => {
      queue.push(callback)
      return () => {
        queue = queue.filter((entry) => entry !== callback)
      }
    },
    run: () => {
      const due = queue
      queue = []
      for (const callback of due) callback()
    },
    pending: () => queue.length,
  }
}

test('the first request paints synchronously, and the rest of the frame paints once', () => {
  const frames = fakeFrames()
  let painted = 0
  const repaint = createRepaint(() => { painted += 1 }, frames.schedule)

  repaint.request()
  assert.equal(painted, 1, 'an idle request is not deferred')

  for (let index = 0; index < 50; index += 1) repaint.request()
  assert.equal(painted, 1, 'a burst inside one frame is collapsed')

  frames.run()
  assert.equal(painted, 2, 'and drawn once at the end of it')
})

test('a frame that owed nothing does not paint, and closes the window', () => {
  const frames = fakeFrames()
  let painted = 0
  const repaint = createRepaint(() => { painted += 1 }, frames.schedule)

  repaint.request()
  frames.run()
  assert.equal(painted, 1, 'nothing asked during the frame, so nothing was drawn')
  assert.equal(frames.pending(), 0, 'and the window is not re-armed forever')

  // The window is open again, so the next request is immediate — this is what
  // keeps a click after a quiet beat from waiting for a frame.
  repaint.request()
  assert.equal(painted, 2)
})

test('an unbroken stream keeps painting, once per frame', () => {
  const frames = fakeFrames()
  let painted = 0
  const repaint = createRepaint(() => { painted += 1 }, frames.schedule)

  for (let frame = 0; frame < 5; frame += 1) {
    for (let chunk = 0; chunk < 20; chunk += 1) repaint.request()
    frames.run()
  }
  // The leading paint, plus one per frame.
  assert.equal(painted, 6)
})

test('flush draws the pending frame now, and only when one is pending', () => {
  const frames = fakeFrames()
  let painted = 0
  const repaint = createRepaint(() => { painted += 1 }, frames.schedule)

  repaint.request()
  repaint.flush()
  assert.equal(painted, 1, 'nothing is owed straight after a paint')

  repaint.request()
  assert.equal(painted, 1, 'deferred: still inside the frame')
  repaint.flush()
  assert.equal(painted, 2, 'a turn boundary does not wait for the frame')

  frames.run()
  assert.equal(painted, 2, 'and the frame it was owed to has nothing left to do')
})

test('cancel drops the pending frame without painting it', () => {
  const frames = fakeFrames()
  let painted = 0
  const repaint = createRepaint(() => { painted += 1 }, frames.schedule)

  repaint.request()
  repaint.request()
  repaint.cancel()
  assert.equal(frames.pending(), 0, 'the scheduled callback is cancelled, not left to fire')

  frames.run()
  assert.equal(painted, 1, 'the deferred paint never happened')

  // A cancelled repaint is idle again, not wedged shut: a pane coming back to
  // the foreground has to be able to paint.
  repaint.request()
  assert.equal(painted, 2)
})

test('the default scheduler works without requestAnimationFrame', async () => {
  const raf = (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame
  assert.equal(raf, undefined, 'node has none, which is the fallback path this asserts')

  let painted = 0
  const repaint = createRepaint(() => { painted += 1 })
  repaint.request()
  repaint.request()
  assert.equal(painted, 1)
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.equal(painted, 2, 'the timer fallback still closes the frame')
})
