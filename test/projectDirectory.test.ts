import test from 'node:test'
import assert from 'node:assert/strict'
import { resolve, sep } from 'node:path'
import {
  ProjectDirectory,
  projectDisplayName,
  projectRootKey,
  type DirectoryProject,
  type DirectoryWorkspace,
  type PaneLike,
} from '../src/runtime/projectDirectory.js'
import type { SessionMeta } from '../src/sessions/service.js'

/**
 * The project tier that `main.ts` cannot cover.
 *
 * Everything here used to be a module-level variable in the Electron main
 * process, which is unimportable under plain node (`app.requestSingleInstanceLock()`
 * runs at module top level). Pulling it into a class is what makes the ordering
 * rules — key normalization, close-then-shutdown, one projection — assertable.
 *
 * Note there is no `as unknown as` anywhere below: `ProjectDirectory` is generic
 * over its two halves, so the fakes are checked against the members the class
 * actually calls instead of being cast past the compiler.
 */

interface FakeProject extends DirectoryProject {
  shutdowns: string[]
}

interface FakeWorkspace extends DirectoryWorkspace {
  panes: PaneLike[]
  closeAllCalls: number
}

/** Records the interleaving, so "closed before shut down" is checkable. */
function fakeProject(cwd: string, log: string[] = []): FakeProject {
  const shutdowns: string[] = []
  return {
    cwd,
    shutdowns,
    shutdown: async (reason) => {
      shutdowns.push(reason)
      log.push(`shutdown:${cwd}`)
    },
  }
}

function fakeWorkspace(cwd: string, panes: PaneLike[] = [], log: string[] = []): FakeWorkspace {
  const workspace: FakeWorkspace = {
    panes,
    closeAllCalls: 0,
    list: () => workspace.panes,
    closeAll: () => {
      workspace.closeAllCalls += 1
      log.push(`closeAll:${cwd}`)
    },
  }
  return workspace
}

function fakePane(id: string, title?: string): PaneLike {
  const session = { id, ...(title !== undefined ? { title } : {}) } as SessionMeta
  return { getSession: () => session }
}

function directory(): ProjectDirectory<FakeProject, FakeWorkspace> {
  return new ProjectDirectory<FakeProject, FakeWorkspace>()
}

test('a project is keyed by its resolved root, so the same directory is one project', () => {
  const dir = directory()
  const root = process.cwd()
  dir.add(fakeProject(root), fakeWorkspace(root))

  // A trailing separator and a `.` hop are the same directory.
  assert.ok(dir.get(root + sep), 'a trailing separator must not mint a second project')
  assert.ok(dir.get(`${root}${sep}.`), 'a "." segment must resolve away')
  assert.equal(dir.size, 1)
})

test('on a case-insensitive filesystem, case does not mint a second project', () => {
  const dir = directory()
  const root = process.cwd()
  dir.add(fakeProject(root), fakeWorkspace(root))

  const flipped = root.toUpperCase()
  const caseInsensitive = process.platform === 'win32' || process.platform === 'darwin'
  // The point is that the directory agrees with `src/utils/paths.ts` about what
  // "the same directory" means, whichever way that platform answers.
  assert.equal(Boolean(dir.get(flipped)), caseInsensitive || flipped === root)
})

test('adding the same root twice throws instead of replacing', () => {
  // Two `ProjectRuntime`s over one `.myagent/` means two `SessionStore`s
  // appending to the same JSONL files; the shell is expected to `get()` first.
  const dir = directory()
  const root = process.cwd()
  dir.add(fakeProject(root), fakeWorkspace(root))
  assert.throws(() => dir.add(fakeProject(root), fakeWorkspace(root)), /already open/)
  assert.equal(dir.size, 1)
})

test('entries() keeps the order projects were opened', () => {
  const dir = directory()
  const a = process.cwd()
  const b = `${process.cwd()}${sep}src`
  dir.add(fakeProject(a), fakeWorkspace(a))
  dir.add(fakeProject(b), fakeWorkspace(b))
  assert.deepEqual(dir.entries().map((entry) => entry.cwd), [a, b])
})

test('entryForPane finds the owning project, and nothing for a stranger', () => {
  const dir = directory()
  const a = process.cwd()
  const b = `${process.cwd()}${sep}src`
  const mine = fakePane('s1')
  const theirs = fakePane('s2')
  const entryA = dir.add(fakeProject(a), fakeWorkspace(a, [mine]))
  const entryB = dir.add(fakeProject(b), fakeWorkspace(b, [theirs]))

  assert.equal(dir.entryForPane(mine), entryA)
  assert.equal(dir.entryForPane(theirs), entryB)
  assert.equal(dir.entryForPane(fakePane('s3')), undefined)
})

test('describe projects the panes it is given, with the project fields filled in', () => {
  const dir = directory()
  const a = `${process.cwd()}${sep}src`
  const b = `${process.cwd()}${sep}test`
  const first = fakePane('s1', 'First')
  const second = fakePane('s2')
  const other = fakePane('s3', 'Other')
  dir.add(fakeProject(a), fakeWorkspace(a, [first, second]))
  dir.add(fakeProject(b), fakeWorkspace(b, [other]))

  assert.deepEqual(dir.describe([first, second, other]), [
    {
      paneId: 's1',
      sessionId: 's1',
      projectRoot: projectRootKey(a),
      projectName: 'src',
      sessionTitle: 'First',
    },
    // No `sessionTitle` key at all for an untitled draft, rather than undefined:
    // the wire is structured-cloned and the tab bar falls back on absence.
    { paneId: 's2', sessionId: 's2', projectRoot: projectRootKey(a), projectName: 'src' },
    {
      paneId: 's3',
      sessionId: 's3',
      projectRoot: projectRootKey(b),
      projectName: 'test',
      sessionTitle: 'Other',
    },
  ])
})

test('describe follows the order it is handed, not the project order', () => {
  // The shell passes its window map, and window order is what the user sees.
  const dir = directory()
  const a = `${process.cwd()}${sep}src`
  const b = `${process.cwd()}${sep}test`
  const mine = fakePane('s1')
  const theirs = fakePane('s2')
  dir.add(fakeProject(a), fakeWorkspace(a, [mine]))
  dir.add(fakeProject(b), fakeWorkspace(b, [theirs]))

  assert.deepEqual(dir.describe([theirs, mine]).map((info) => info.paneId), ['s2', 's1'])
})

test('describe drops a pane no open project owns', () => {
  // A pane whose project was just closed must not be advertised as a tab.
  const dir = directory()
  const a = process.cwd()
  dir.add(fakeProject(a), fakeWorkspace(a, []))
  assert.deepEqual(dir.describe([fakePane('ghost')]), [])
})

test('closeProject closes every pane before shutting the project down', () => {
  // The reverse order pulls the tools out from under panes that are still
  // draining: `shutdown()` stops background tasks and MCP clients, `closeAll()`
  // runs each pane's fixed four-step teardown.
  const log: string[] = []
  const dir = directory()
  const root = process.cwd()
  const entry = dir.add(fakeProject(root, log), fakeWorkspace(root, [fakePane('s1')], log))

  return dir.closeProject(entry, 'project-closed').then(() => {
    assert.deepEqual(log, [`closeAll:${root}`, `shutdown:${root}`])
    assert.deepEqual(entry.project.shutdowns, ['project-closed'])
    assert.equal(dir.size, 0)
    assert.equal(dir.get(root), undefined)
  })
})

test('closeProject is idempotent, so quit and last-window-closed can both arrive', async () => {
  const dir = directory()
  const root = process.cwd()
  const entry = dir.add(fakeProject(root), fakeWorkspace(root))

  await Promise.all([
    dir.closeProject(entry, 'first'),
    dir.closeProject(entry, 'second'),
  ])
  await dir.closeProject(entry, 'third')

  assert.deepEqual(entry.project.shutdowns, ['first'])
  assert.equal(entry.workspace.closeAllCalls, 1)
})

test('shutdownAll closes every project and empties the directory', async () => {
  const dir = directory()
  const a = process.cwd()
  const b = `${process.cwd()}${sep}src`
  const entryA = dir.add(fakeProject(a), fakeWorkspace(a, [fakePane('s1')]))
  const entryB = dir.add(fakeProject(b), fakeWorkspace(b, [fakePane('s2')]))

  await dir.shutdownAll('app-quit')

  assert.deepEqual(entryA.project.shutdowns, ['app-quit'])
  assert.deepEqual(entryB.project.shutdowns, ['app-quit'])
  assert.equal(dir.size, 0)
})

test('shutdownAll does not let one failing project keep the others open', async () => {
  // On the way out a misbehaving MCP server must not block the quit.
  const dir = directory()
  const a = process.cwd()
  const b = `${process.cwd()}${sep}src`
  const broken = fakeProject(a)
  broken.shutdown = async () => {
    throw new Error('server hung')
  }
  dir.add(broken, fakeWorkspace(a))
  const entryB = dir.add(fakeProject(b), fakeWorkspace(b))

  await dir.shutdownAll('app-quit')

  assert.deepEqual(entryB.project.shutdowns, ['app-quit'])
  assert.equal(dir.size, 0)
})

test('projectDisplayName is the basename, falling back to the path for a root', () => {
  assert.equal(projectDisplayName(`${process.cwd()}${sep}src`), 'src')
  // `basename('C:\\')` and `basename('/')` are both empty, and a nameless tab
  // group heading is worse than a long one.
  const filesystemRoot = process.platform === 'win32' ? 'C:\\' : '/'
  assert.equal(projectDisplayName(filesystemRoot), resolve(filesystemRoot))
})
