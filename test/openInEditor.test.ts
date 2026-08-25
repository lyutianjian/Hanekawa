import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { openInEditor, type SpawnLike, type SpawnOptions } from '../src/desktop/openInEditor.js'

/**
 * The `code <cwd>` launcher.
 *
 * Its own module precisely so this file can exist: the platform branch is
 * invisible from the host it is not running on, and `main.ts` — where this code
 * would otherwise live — has no unit test at all.
 */

interface Launch {
  command: string
  args: readonly string[]
  options: SpawnOptions
}

/**
 * A child process that does nothing until the test says so.
 *
 * An `EventEmitter` with `unref`, which is the whole surface `openInEditor`
 * touches — `once('error')`, `once('exit')`, `unref()`. Recording `unref` is not
 * decoration: a referenced child keeps the Electron main process alive for as
 * long as the editor runs.
 */
class FakeChild extends EventEmitter {
  unrefs = 0
  unref(): void {
    this.unrefs += 1
  }
}

function fakeSpawn(): { spawn: SpawnLike; launches: Launch[]; children: FakeChild[] } {
  const launches: Launch[] = []
  const children: FakeChild[] = []
  const spawn: SpawnLike = (command, args, options) => {
    launches.push({ command, args, options })
    const child = new FakeChild()
    children.push(child)
    return child as unknown as ChildProcess
  }
  return { spawn, launches, children }
}

test('posix passes the path as one argv entry, unquoted', async () => {
  const { spawn, launches, children } = fakeSpawn()
  const done = openInEditor('/home/me/my project', { spawn, platform: 'linux', graceMs: 50 })
  children[0]!.emit('exit', 0)
  await done

  assert.deepEqual(launches, [
    {
      command: 'code',
      args: ['/home/me/my project'],
      options: { detached: true, stdio: 'ignore' },
    },
  ])
  assert.equal(children[0]!.unrefs, 1, 'the child must not hold the app open')
})

test('windows goes through cmd.exe with the path quoted verbatim', async () => {
  // `code` on Windows is `code.cmd`, which Node refuses to spawn directly since
  // 18.20. The quoting is what makes `&` in a path data rather than a separator,
  // and it is safe because a Windows path cannot contain a double quote.
  const { spawn, launches, children } = fakeSpawn()
  const done = openInEditor('C:\\repo\\a&b', { spawn, platform: 'win32', graceMs: 50 })
  children[0]!.emit('exit', 0)
  await done

  assert.deepEqual(launches[0]!.command, 'cmd.exe')
  assert.deepEqual(launches[0]!.args, ['/c', 'code', '"C:\\repo\\a&b"'])
  assert.equal(launches[0]!.options.windowsVerbatimArguments, true)
})

test('a nonzero exit is reported as "code is not installed"', async () => {
  // The Windows case this exists for: `cmd.exe` starts perfectly well and then
  // fails to find `code`, so `spawn` succeeding proves nothing.
  const { spawn, children } = fakeSpawn()
  const done = openInEditor('C:\\repo', { spawn, platform: 'win32', graceMs: 50 })
  children[0]!.emit('exit', 1)

  await assert.rejects(done, /code 命令/)
})

test('ENOENT is reported as "code is not installed" too, and other errors verbatim', async () => {
  const first = fakeSpawn()
  const missing = openInEditor('/repo', { spawn: first.spawn, platform: 'linux', graceMs: 50 })
  const enoent: NodeJS.ErrnoException = Object.assign(new Error('spawn code ENOENT'), { code: 'ENOENT' })
  first.children[0]!.emit('error', enoent)
  await assert.rejects(missing, /code 命令/)

  const second = fakeSpawn()
  const denied = openInEditor('/repo', { spawn: second.spawn, platform: 'linux', graceMs: 50 })
  second.children[0]!.emit('error', Object.assign(new Error('EACCES'), { code: 'EACCES' }))
  await assert.rejects(denied, /EACCES/)
})

test('a launcher that stays alive resolves rather than hanging the request', async () => {
  // An editor started in the foreground never exits. The renderer's promise must
  // not wait for it — the launch plainly worked.
  const { spawn, children } = fakeSpawn()
  await openInEditor('/repo', { spawn, platform: 'linux', graceMs: 1 })
  assert.equal(children[0]!.unrefs, 1)
})

test('the first outcome wins; a later event cannot settle it twice', async () => {
  // `exit` after `error` is the normal sequence for a failed spawn. A second
  // settle would be an unhandled rejection rather than a visible failure.
  const { spawn, children } = fakeSpawn()
  const done = openInEditor('/repo', { spawn, platform: 'linux', graceMs: 50 })
  children[0]!.emit('error', Object.assign(new Error('boom'), { code: 'EPERM' }))
  children[0]!.emit('exit', 0)
  await assert.rejects(done, /boom/)
})
