import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test, { mock } from 'node:test'

import { CdpSession, type CdpContents } from '../src/desktop/browser/cdpSession.js'
import { BrowserHostError } from '../src/desktop/browser/errors.js'

/** A `WebContents` reduced to its debugger and the three events the session hears. */
class FakeDebugger extends EventEmitter {
  attached = false
  attaches = 0
  detaches = 0
  failAttach: string | undefined
  isAttached(): boolean {
    return this.attached
  }
  attach(): void {
    if (this.failAttach !== undefined) throw new Error(this.failAttach)
    this.attached = true
    this.attaches++
  }
  detach(): void {
    this.attached = false
    this.detaches++
  }
  async sendCommand(method: string): Promise<unknown> {
    if (!this.attached) throw new Error('not attached')
    return { method }
  }
  /** What Electron does when the target is taken from outside. */
  kick(reason = 'target closed'): void {
    this.attached = false
    this.emit('detach', {}, reason)
  }
}

class FakeContents extends EventEmitter {
  readonly debugger = new FakeDebugger()
  destroyed = false
  devTools = false
  isDestroyed(): boolean {
    return this.destroyed
  }
  isDevToolsOpened(): boolean {
    return this.devTools
  }
  openDevTools(): void {
    this.devTools = true
    this.emit('devtools-opened')
  }
}

const IDLE = 1000

function setup(): { contents: FakeContents; session: CdpSession } {
  mock.timers.enable({ apis: ['setTimeout'] })
  const contents = new FakeContents()
  return { contents, session: new CdpSession(contents as unknown as CdpContents, IDLE) }
}

async function rejectsRetryable(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof BrowserHostError)
    assert.equal(error.code, 'PAGE_NOT_READY')
    assert.equal(error.retryable, true)
    assert.match(error.message, pattern)
    return true
  })
}

test.afterEach(() => mock.timers.reset())

test('attaches on the first command, not on acquire', async () => {
  const { contents, session } = setup()
  const release = session.acquire()
  assert.equal(contents.debugger.attaches, 0)
  await session.send('Input.dispatchMouseEvent')
  await session.send('Input.dispatchMouseEvent')
  assert.equal(contents.debugger.attaches, 1)
  release()
})

test('stays attached while any lease is held and detaches once idle after the last', async () => {
  const { contents, session } = setup()
  const a = session.acquire()
  const b = session.acquire()
  await session.send('X')
  a()
  mock.timers.tick(IDLE * 5)
  assert.equal(contents.debugger.attached, true)
  b()
  mock.timers.tick(IDLE - 1)
  assert.equal(contents.debugger.attached, true)
  mock.timers.tick(1)
  assert.equal(contents.debugger.attached, false)
})

test('a new lease inside the idle window cancels the detach', async () => {
  const { contents, session } = setup()
  session.acquire()()
  await session.send('X')
  const again = session.acquire()
  mock.timers.tick(IDLE * 2)
  assert.equal(contents.debugger.attached, true)
  assert.equal(contents.debugger.attaches, 1)
  again()
})

test('a release is counted once', async () => {
  const { contents, session } = setup()
  const a = session.acquire()
  const b = session.acquire()
  await session.send('X')
  a()
  a()
  mock.timers.tick(IDLE)
  assert.equal(contents.debugger.attached, true)
  b()
})

test('a command outside any lease is still detached once idle', async () => {
  const { contents, session } = setup()
  await session.send('X')
  mock.timers.tick(IDLE)
  assert.equal(contents.debugger.attached, false)
})

test('an outside detach zeroes the count, and a stale release cannot undo a newer lease', async () => {
  const { contents, session } = setup()
  const stale = session.acquire()
  await session.send('X')
  contents.debugger.kick()
  const fresh = session.acquire()
  await session.send('X')
  assert.equal(contents.debugger.attaches, 2)
  stale()
  mock.timers.tick(IDLE * 2)
  assert.equal(contents.debugger.attached, true)
  fresh()
  mock.timers.tick(IDLE)
  assert.equal(contents.debugger.attached, false)
})

test('opening DevTools detaches, and commands are refused until it closes', async () => {
  const { contents, session } = setup()
  session.acquire()
  await session.send('X')
  contents.openDevTools()
  assert.equal(contents.debugger.attached, false)
  await rejectsRetryable(session.send('X'), /close DevTools/)
  assert.equal(contents.debugger.attaches, 1)
  contents.devTools = false
  await session.send('X')
  assert.equal(contents.debugger.attaches, 2)
})

test('a failed attach is a retryable refusal naming DevTools', async () => {
  const { contents, session } = setup()
  contents.debugger.failAttach = 'Another debugger is already attached'
  await rejectsRetryable(session.send('X'), /Another debugger.*DevTools/)
})

test('a destroyed page is refused without touching the debugger', async () => {
  const { contents, session } = setup()
  const release = session.acquire()
  contents.destroyed = true
  contents.emit('destroyed')
  await rejectsRetryable(session.send('X'), /page is gone/)
  release()
  mock.timers.tick(IDLE)
  assert.equal(contents.debugger.detaches, 0)
})
