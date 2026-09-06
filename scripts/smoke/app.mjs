/**
 * The app under test: launching it, attaching to it, and talking to its wire.
 *
 * Three things here are not obvious and are load-bearing.
 *
 * **The scratch project.** The app is always launched with `--cwd=<temp dir>`
 * (`resolveCwd`, `src/desktop/main.ts:474`). The smoke run deletes sessions and
 * rewrites provider config, and the repository's own `.myagent/` holds the
 * developer's real sessions and real API keys. Pointing the app at a temp
 * directory is what makes those steps safe by construction rather than by care.
 *
 * **The page tap.** The renderer keeps its lane mux private
 * (`src/desktop/renderer/app.ts:87`), so this driver builds mux envelopes
 * itself: `{kind:'data', lane, body}`. `window.hanekawa.onMessage` registers an
 * *additional* listener (`src/desktop/preload.ts`), so a tap sees every frame
 * without disturbing the app's own subscription. It claims only replies whose id
 * starts with `smoke-`; the app's ids are UUIDs and `PendingRequests.settle`
 * ignores ids it does not know, so neither side sees the other's traffic.
 *
 * The tap *projects* rather than stores frames. `session-event` fires per token
 * and `snapshot` fires on every background-task output flush; keeping whole
 * bodies would overrun the buffer inside one streaming turn and make each poll
 * megabytes of JSON over CDP.
 *
 * **The modal watchdog.** `dialog.showErrorBox` / `showOpenDialog` /
 * `showMessageBoxSync` block the *main* process. The renderer keeps answering
 * `Runtime.evaluate` perfectly, and a screenshot shows a healthy-looking page
 * with the OS dialog invisible above it — but no wire reply can ever arrive
 * again. `liveness()` is the only detector, which is why it runs between steps.
 */
import { spawn, spawnSync } from 'node:child_process'
import { createWriteStream, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { SHELL_LANE, TAP_SOURCE } from './tap.mjs'
import { clearViewport, connect, evaluate, findPageTarget, setViewport, sleep, waitFor } from './cdp.mjs'

const require_ = createRequire(import.meta.url)

/** Absolute path to the installed Electron executable. */
export function electronBinary() {
  return require_('electron')
}

/**
 * Every running Electron process id.
 *
 * Windows-only by design: `taskkill`/`tasklist` are the only way to kill a
 * process *tree* on Windows, and this driver's whole point is to be run on the
 * platform the desktop app ships to. On other platforms the accounting degrades
 * to "wait for our own child", which is still correct, just less thorough.
 */
export function electronPids() {
  if (process.platform !== 'win32') return []
  // Through `execFile` semantics, never a shell: Git Bash rewrites `/FI` into a
  // path, which is exactly the kind of thing that gets "fixed" by adding `sh -c`.
  const result = spawnSync('tasklist', ['/FI', 'IMAGENAME eq electron.exe', '/FO', 'CSV', '/NH'], {
    encoding: 'utf8',
    shell: false,
  })
  if (result.status !== 0 || !result.stdout) return []
  const pids = []
  for (const line of result.stdout.split(/\r?\n/)) {
    const columns = line.split('","')
    if (columns.length < 2) continue
    const pid = Number(columns[1])
    if (Number.isInteger(pid)) pids.push(pid)
  }
  return pids
}

export function isAlive(pid) {
  if (!Number.isInteger(pid)) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

/**
 * Kills a process and its children.
 *
 * `process.kill` is deliberately not used: on Windows it terminates the parent
 * only and orphans the GPU and renderer children, which then hold the
 * single-instance lock against the next run.
 */
export function killTree(pid) {
  if (!Number.isInteger(pid)) return
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', shell: false })
    return
  }
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // Already gone.
    }
  }
}

/** Registered so every exit path kills the child, including a driver crash. */
const liveApps = new Set()
let cleanupInstalled = false

function installCleanup() {
  if (cleanupInstalled) return
  cleanupInstalled = true
  // Synchronous on purpose: an async kill scheduled from an `exit` handler never
  // runs, and that is precisely the case that leaves an orphan behind.
  const cleanup = () => {
    for (const app of liveApps) {
      killTree(app.pid)
      try {
        rmSync(app.pidFile, { force: true })
      } catch {
        // Nothing to do while exiting.
      }
    }
    liveApps.clear()
  }
  process.on('exit', cleanup)
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => {
      cleanup()
      process.exit(130)
    })
  }
  process.on('uncaughtException', (error) => {
    cleanup()
    console.error(error)
    process.exit(2)
  })
  process.on('unhandledRejection', (error) => {
    cleanup()
    console.error(error)
    process.exit(2)
  })
}

/**
 * Starts Electron and returns the app handle. Does not attach.
 *
 * The pidfile is written before anything else so a *later* run can recognise
 * this run's leftover and is allowed to kill it — as opposed to killing whatever
 * Electron app the developer happens to have open.
 */
export function launch({ repoRoot, cwd, port, out, tag, pidFile }) {
  installCleanup()
  const log = createWriteStream(join(out, `electron-${tag}.log`), { flags: 'a' })
  const child = spawn(
    electronBinary(),
    [repoRoot, `--remote-debugging-port=${port}`, `--cwd=${cwd}`],
    { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'], shell: false },
  )
  // An undrained pipe stalls the child once the OS buffer fills.
  child.stdout.pipe(log)
  child.stderr.pipe(log)

  const app = {
    child,
    pid: child.pid,
    port,
    out,
    tag,
    pidFile,
    cwd,
    log,
    cdp: undefined,
    /** Renderer exceptions. A non-empty list fails the run regardless of steps. */
    exceptions: [],
    consoleLines: [],
    exited: undefined,
    nextId: 0,
  }
  writeFileSync(pidFile, String(child.pid), 'utf8')
  liveApps.add(app)
  child.on('exit', (code, signal) => {
    app.exited = { code, signal }
    liveApps.delete(app)
    try {
      rmSync(pidFile, { force: true })
    } catch {
      // Fine — the next run's preflight tolerates a stale pidfile.
    }
  })
  return app
}

/**
 * Attaches to the app's page and waits until the whole chain is up.
 *
 * The readiness probe is the window title. `statusView.renderSession` sets it
 * only after `hello()` resolves (`dom/statusView.ts:47-53`), so it proves
 * preload → mux → shell lane → SessionHost → controller all came up, with no
 * instrumentation added to the app for the driver's benefit.
 */
export async function attach(app, { timeout = 45000 } = {}) {
  const target = await findPageTarget(app.port, { timeout })
  const rendererLog = createWriteStream(join(app.out, `renderer-${app.tag}.log`), { flags: 'a' })
  app.cdp = await connect(target.webSocketDebuggerUrl, {
    onEvent: (frame) => {
      if (frame.method === 'Runtime.consoleAPICalled') {
        const text = (frame.params.args ?? [])
          .map((arg) => arg.value ?? arg.description ?? arg.type)
          .join(' ')
        app.consoleLines.push(`[${frame.params.type}] ${text}`)
        rendererLog.write(`[${frame.params.type}] ${text}\n`)
        return
      }
      if (frame.method === 'Runtime.exceptionThrown') {
        const details = frame.params.exceptionDetails
        const text = details?.exception?.description ?? details?.text ?? 'unknown exception'
        app.exceptions.push(text)
        rendererLog.write(`[exception] ${text}\n`)
        return
      }
      if (frame.method === 'Inspector.targetCrashed' || frame.method === 'Inspector.detached') {
        // Expected once teardown starts — closing the page detaches the
        // inspector. Counting that as a renderer failure would fail every
        // otherwise-green run, so only an unexpected detach is a finding.
        if (app.closing) {
          rendererLog.write(`[${frame.method}] during teardown, expected\n`)
          return
        }
        app.exceptions.push(`inspector: ${frame.method}`)
        rendererLog.write(`[${frame.method}]\n`)
      }
    },
  })
  await app.cdp.send('Runtime.enable')
  await app.cdp.send('Page.enable')
  // Makes key dispatch behave the same whether or not the OS window is
  // foreground — otherwise a run fails depending on where the mouse was.
  await app.cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  // Rule 2 from `cdp.mjs`: no `Target.setDiscoverTargets`, ever.
  await evaluate(app.cdp, TAP_SOURCE)
  await waitFor(
    'the window title to show a session (hello() resolved)',
    () => evaluate(app.cdp, "document.title.startsWith('Hanekawa — ')"),
    { timeout },
  )
  return app
}

// --- the wire ----------------------------------------------------------------

/** Sends a command without waiting for its reply. Returns the id. */
export async function post(app, lane, body) {
  const id = `smoke-${++app.nextId}`
  const envelope = JSON.stringify({ kind: 'data', lane, body: { ...body, id } })
  await evaluate(app.cdp, `window.hanekawa.send(${envelope}), '${id}'`)
  return id
}

/**
 * Collects a reply posted earlier.
 *
 * Separate from `post` because three commands must never be awaited inline:
 * `close-pane` self-destructs the lane's host so its reply is lost by
 * construction, `submit` answers only when the whole turn ends, and a `run-tool`
 * that raises a permission prompt answers only after the prompt is answered.
 */
export async function reply(app, id, { timeout = 20000, label = id } = {}) {
  const result = await waitFor(
    `a reply to ${label}`,
    () =>
      evaluate(
        app.cdp,
        `(() => { const r = window.__smoke.replies.get('${id}'); if (!r) return null; window.__smoke.replies.delete('${id}'); return r })()`,
      ),
    { timeout },
  )
  if (!result.ok) throw new Error(`${label} failed: ${result.message}`)
  return result.result
}

export async function call(app, lane, body, options = {}) {
  const id = await post(app, lane, body)
  return reply(app, id, { label: `${lane}/${body.type}`, ...options })
}

export function shell(app, body, options = {}) {
  return call(app, SHELL_LANE, body, options)
}

/** Whether a reply for `id` has already landed, without consuming it. */
export function hasReply(app, id) {
  return evaluate(app.cdp, `window.__smoke.replies.has('${id}')`)
}

/** The tap's projected frames after `sinceSeq`, plus the new high-water mark. */
export async function events(app, sinceSeq = 0) {
  return evaluate(
    app.cdp,
    `(() => { const s = window.__smoke; return { seq: s.seq, entries: s.events.filter((e) => e.seq > ${sinceSeq}) } })()`,
  )
}

/** The tap's per-lane latest state: streaming, runtime snapshot, bound session. */
export function laneState(app) {
  return evaluate(app.cdp, 'window.__smoke.snapshotState()')
}

/**
 * Proves the main process is still answering.
 *
 * A native modal is invisible to both the renderer and a screenshot, so this
 * round trip is the only detector. Kept short: the failure it looks for is
 * permanent, so waiting longer only wastes the run.
 */
export async function liveness(app, { timeout = 3000 } = {}) {
  try {
    await shell(app, { type: 'panes' }, { timeout })
    return true
  } catch (error) {
    throw new Error(
      `the main process is not answering (${error instanceof Error ? error.message : String(error)}). ` +
        `A native modal is probably up — look at the screen, then kill PID ${app.pid}.`,
    )
  }
}

// --- teardown ----------------------------------------------------------------

/**
 * Closes the window and waits for the process to exit on its own.
 *
 * This is also the test of `before-quit`: it cancels the first quit, drains
 * lanes and projects, then quits again (`src/desktop/main.ts:116-127`). A kill
 * would skip exactly the code that stops MCP children and background tasks, so
 * "we had to kill it" is reported rather than hidden.
 */
export async function quitGracefully(app, { timeout = 12000 } = {}) {
  if (app.exited) return 'already-exited'
  app.closing = true
  const exit = new Promise((resolve) => {
    if (app.exited) return resolve('graceful')
    app.child.once('exit', () => resolve('graceful'))
  })
  try {
    // Not awaited: closing the page tears down the transport this reply would
    // have travelled on.
    void app.cdp?.send('Page.close').catch(() => {})
  } catch {
    // Already detached; fall through to the timeout and the kill.
  }
  const outcome = await Promise.race([exit, sleep(timeout).then(() => 'timeout')])
  app.cdp?.close()
  if (outcome === 'graceful') return 'graceful'
  killTree(app.pid)
  await Promise.race([exit, sleep(3000)])
  return 'killed'
}

/**
 * Waits until the app's process really is gone, killing the tree if it is not.
 *
 * The step before deleting the scratch directory, and the one that was missing:
 * `quitGracefully` can answer `killed` while the renderer and GPU children are
 * still exiting, and on Windows a child holding a session file under `.myagent/`
 * makes `rmSync` fail half-way through. Returns a note when it had to intervene,
 * `undefined` when the app was already down.
 */
export async function ensureStopped(app, { timeout = 8000 } = {}) {
  if (!app || app.exited || !isAlive(app.pid)) return undefined
  killTree(app.pid)
  const deadline = Date.now() + timeout
  while (Date.now() < deadline && isAlive(app.pid)) await sleep(200)
  return isAlive(app.pid)
    ? `pid ${app.pid} is STILL alive after the kill — the scratch directory may not delete`
    : `killed pid ${app.pid} before cleaning up`
}

export { clearViewport, setViewport, SHELL_LANE }

/**
 * Preflight: refuse to run when the result could not be trusted.
 *
 * The single-instance lock (`src/desktop/main.ts:95`) is why this is not
 * optional — with a stale Electron holding it, the new launch quits immediately
 * and every assertion fails for a reason that has nothing to do with the app.
 */
export function preflightProcesses({ port, pidFile, killStale }) {
  const notes = []
  if (existsSync(pidFile)) {
    const pid = Number(readFileSync(pidFile, 'utf8').trim())
    if (isAlive(pid)) {
      // Ours by construction: only this driver writes that file.
      killTree(pid)
      notes.push(`killed a leftover app from a previous run (pid ${pid})`)
    }
    rmSync(pidFile, { force: true })
  }
  const pids = electronPids()
  if (pids.length > 0) {
    if (!killStale) {
      throw new Error(
        `electron.exe is already running (pids ${pids.join(', ')}). ` +
          'The single-instance lock would make this run measure that process instead. ' +
          'Close it, or re-run with --kill-stale.',
      )
    }
    for (const pid of pids) killTree(pid)
    notes.push(`--kill-stale killed pids ${pids.join(', ')}`)
  }
  return { baseline: electronPids(), notes, port }
}
