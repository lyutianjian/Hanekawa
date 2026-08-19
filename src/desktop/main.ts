/**
 * The Electron main process.
 *
 * Multi-project, multi-pane desktop shell: one `BrowserWindow` per session, one
 * `ProjectRuntime` + `SessionWorkspace` per project root, and a
 * `ProjectDirectory` above them holding the bookkeeping that spans projects. The
 * composition of any single project mirrors `src/tui/entrypoints/tui.tsx` —
 * `bootstrap()` returns the merged `RuntimeHost`, a `SessionWorkspace` keeps the
 * panes alive, and `SessionHost` does the runtime/protocol work for each one.
 * Everything TUI-shaped is not here; everything renderer-shaped is not here.
 *
 * Lifecycle:
 *  1. `openProject(cwd)` is the only way a project comes into existence, and the
 *     first project goes through it exactly like the fifth. Inside it,
 *     `bootstrap()` runs with a synchronous `confirmMcpTrust` that drives
 *     `dialog.showMessageBoxSync` for each untrusted MCP server — this fires
 *     before any channel exists, the only place a pre-channel prompt can live.
 *  2. `openPane(project, { sessionId?, title? })` builds the window, wires the
 *     channel and constructs `SessionHost` **before** loading the page. The
 *     channel is what makes the attach lossless, and there is deliberately no
 *     ready handshake. The same routine opens the first pane and every
 *     subsequent tab, so a renderer-initiated `open-pane` reaches the same wiring.
 *  3. A project is shut down when its last window closes (`afterPaneDetached`) —
 *     `ProjectRuntime.shutdown` is the only call that stops background tasks and
 *     MCP clients, so keeping a window-less project alive would leave child
 *     processes running with nothing on screen to stop them.
 *  4. On `before-quit` we tear down every pane in order and wait for it, then
 *     shut every project down. `window-all-closed` quits only when there are no
 *     panes left.
 *
 * Two keys, and they are not interchangeable: `panes` is keyed by
 * `BrowserWindow.id` (session ids move under `/clear` and `/resume`, window ids
 * do not), and the project map inside `ProjectDirectory` is keyed by the
 * normalized project root.
 *
 * The `node:fs` imports and the wall-clock commands stay here, never in the
 * renderer bundle.
 */
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SessionStore } from '../sessions/service.js'
import { logDiagnostics } from '../harness/diagnostics.js'
import type { McpServerConfig } from '../services/mcp/index.js'
import { bootstrap, RuntimeStartupError } from '../runtime/index.js'
import { ProjectDirectory, type ProjectEntry } from '../runtime/projectDirectory.js'
import {
  SessionWorkspace,
  type SessionPane,
} from '../runtime/sessionWorkspace.js'
import { SessionHost } from '../runtime/protocol/host.js'
import type { WirePaneInfo } from '../runtime/protocol/wire.js'
import {
  createElectronMainChannel,
  ELECTRON_RUNTIME_CHANNEL,
  type MainSideIpc,
} from './ipc/electronChannel.js'

/**
 * Where this module's own siblings live — `preload.js` and `renderer/` are
 * emitted next to `main.js` under `dist/desktop/`.
 *
 * Anchored to the module rather than counted back to the repo root on purpose.
 * The previous `new URL('..', import.meta.url)` was written as if this file sat
 * one level deep, but the *emitted* file is `dist/desktop/main.js`, so it
 * resolved to `dist/` and every asset path came out as `dist/dist/desktop/…`.
 * Depth is now nobody's business but the bundler's.
 */
const bundleDir = dirname(fileURLToPath(import.meta.url))

// A plain annotation rather than `as unknown as`: `ipcMain` really is
// assignable to `MainSideIpc`, and letting the compiler confirm that is what
// keeps the structural types honest about the Electron API.
const mainIpc: MainSideIpc = ipcMain

interface PaneEntry {
  pane: SessionPane
  sessionHost: SessionHost
  window: BrowserWindow
  /** The project this window belongs to. Never moves; a pane cannot change project. */
  project: ProjectEntry
}

/**
 * Indexed by `BrowserWindow.id`, not by session id.
 *
 * `paneId` in `WirePaneInfo` is the session id by design (one pane per session,
 * see `sessionWorkspace.ts`), but the *window* is what survives `/clear` and
 * `/resume` — those retarget the controller, so the session id moves while the
 * window id does not. Indexing by the moving key would mean an `onPaneClosed`
 * from the host (which carries the post-`/clear` session id) never finds the
 * entry to destroy, and the window leaks alongside its `SessionHost`.
 *
 * Insertion-ordered, which is what makes this the source of the tab list: the
 * projection only describes panes that have a window, so every row the renderer
 * draws is a row it can focus.
 */
const panes = new Map<number, PaneEntry>()
/** Every open project. All decisions that used to be module-level variables live here. */
const directory = new ProjectDirectory()
let quitting = false

if (!app.requestSingleInstanceLock()) {
  // `app.quit()` does not stop module evaluation, so everything below has to
  // stay inside the else — otherwise a second instance runs a whole
  // `bootstrap()` (MCP connects, store init) on a process that is exiting.
  app.quit()
} else {
  app.on('second-instance', (_event, argv, workingDirectory) => {
    // A second launch is a request for *that* directory's project: open it if it
    // is new, focus it if it is already here. Launching in the same directory
    // therefore behaves as it always did — focus, no second runtime.
    void openProjectInteractive(resolveCwd(argv, workingDirectory))
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit()
    }
  })

  app.on('before-quit', (event) => {
    if (quitting) return
    quitting = true
    // Teardown is async and Electron will not wait for it on its own:
    // `project.shutdown()` is the only place background tasks get stopped, so
    // exiting out from under it leaks child processes. Cancel this quit, drain,
    // then quit again — the guard above lets the second pass through.
    event.preventDefault()
    void teardown().finally(() => {
      app.quit()
    })
  })

  app.on('activate', () => {
    // On macOS the dock icon survives a window close; if a project is still
    // alive but its last window was closed, spawn a fresh tab so the user is
    // not staring at an empty dock.
    if (BrowserWindow.getAllWindows().length === 0) {
      const first = directory.entries()[0]
      if (first) void openPane(first, {})
    }
  })

  void app.whenReady().then(async () => {
    try {
      await openProject(resolveCwd())
    } catch (error) {
      if (error instanceof RuntimeStartupError) {
        dialog.showErrorBox('Hanekawa failed to start', error.message)
      } else {
        dialog.showErrorBox(
          'Hanekawa failed to start',
          error instanceof Error ? (error.stack ?? error.message) : String(error),
        )
      }
      app.quit()
    }
  })
}

/**
 * Brings a project into the process, or focuses it if it is already here.
 *
 * The idempotence is the point: `directory.add` refuses a duplicate root, since
 * two `ProjectRuntime`s over one `.myagent/` means two `SessionStore`s appending
 * to the same JSONL files. Checking first turns "open this project" into a safe
 * request no matter how often the user makes it.
 *
 * Throws rather than reporting: the startup path wants an error box and a quit,
 * the interactive path wants an error box and to carry on. `openProjectInteractive`
 * is that second policy.
 */
async function openProject(cwd: string): Promise<void> {
  const open = directory.get(cwd)
  if (open) {
    focusProject(open)
    return
  }

  const store = new SessionStore(cwd)
  await store.init()

  // `list()` is sorted newest-first, so `at(0)` resumes the most recent
  // session. A project that has never run the agent gets an in-memory draft,
  // exactly as the TUI does — nothing touches disk until the first `message`
  // record, so this costs nothing if the user closes the window immediately.
  const sessions = await store.list()
  const session = sessions.at(0) ?? store.createDraft()

  const project = await bootstrap({
    cwd,
    store,
    session,
    confirmMcpTrust: promptTrustMcpServer,
  })

  logDiagnostics(project.diagnostics)
  const workspace = new SessionWorkspace(project)
  // The bootstrap session is the first pane; `adopt` registers the existing
  // scope without rebuilding it (which `open` would). Pass the resumed
  // session id so `openPane` resolves to the adopted pane rather than minting
  // a fresh draft and leaving a window-less ghost behind in the workspace.
  workspace.adopt(project)
  const entry = directory.add(project, workspace)

  const opened = await openPane(entry, { sessionId: session.id })
  if (!opened) {
    // The window failed to build and `openPane` already said so. Do not leave a
    // project with no way to reach it — that is a live MCP connection set and a
    // background task registry nothing on screen can stop.
    await directory.closeProject(entry, 'window-failed')
  }
}

/**
 * The interactive policy for `openProject`: pick a directory if none was given,
 * report failures without taking the process down.
 *
 * `path` comes from the wire (`open-project`), where it is optional so this can
 * be driven without touching a native modal — CDP cannot click one.
 */
async function openProjectInteractive(path?: string): Promise<void> {
  try {
    const target = path ?? (await promptForProjectDirectory())
    if (!target) return
    await openProject(target)
  } catch (error) {
    dialog.showErrorBox(
      'Hanekawa could not open that project',
      error instanceof Error ? error.message : String(error),
    )
  }
}

/** Native directory picker. Cancelling is a no-op, not an error. */
async function promptForProjectDirectory(): Promise<string | undefined> {
  const result = await dialog.showOpenDialog({
    title: 'Open project',
    buttonLabel: 'Open',
    properties: ['openDirectory', 'createDirectory'],
  })
  if (result.canceled) return undefined
  return result.filePaths[0]
}

async function teardown(): Promise<void> {
  // Every pane first, in the fixed four-step order inside `workspace.close`
  // (`interrupt('exit')` → controller → slot → scope), then the projects: a
  // project shut down under a live pane pulls the tools out from beneath a turn
  // that is still draining.
  for (const entry of [...panes.values()]) {
    entry.sessionHost.dispose()
    entry.project.workspace.close(entry.pane)
    if (!entry.window.isDestroyed()) entry.window.destroy()
  }
  panes.clear()
  await directory.shutdownAll('app-quit')
}

/**
 * Opens a new tab in `project`.
 *
 * The options shape matches `HostCommand.open-pane`: omit `sessionId` to mint a
 * fresh draft, or pass one to resolve an existing session. The shell's role is
 * the same either way: build a window, build a `RuntimeChannel` over it, attach
 * a `SessionHost`.
 *
 * A pane is always created in the project the requesting host belongs to — a
 * host resolves sessions out of its own store, and cross-project work reaches
 * the shell through `focus-pane` / `open-project` instead. Returns the entry, or
 * `undefined` after reporting a failure.
 */
async function openPane(
  owner: ProjectEntry,
  options: { sessionId?: string; title?: string },
): Promise<PaneEntry | undefined> {
  let entry: PaneEntry | null = null

  try {
    // 1. Find or build the pane for the requested session.
    let pane: SessionPane
    if (options.sessionId) {
      const existing = owner.workspace.paneForSession(options.sessionId)
      if (existing) {
        pane = existing
      } else {
        const session = await owner.project.store.resolve(options.sessionId)
        if (!session) throw new Error(`Session not found: ${options.sessionId}`)
        pane = await owner.workspace.open(session)
      }
    } else {
      // A fresh draft. Mirrors `bootstrap()`: `store.createDraft` is in-memory
      // until the first message record.
      const scope = await owner.project.openScope(owner.project.store.createDraft(options.title))
      pane = owner.workspace.adopt(scope, {})
    }

    // 2. Build the window and the channel. `ipcMain.on` is registered the
    //    first time a renderer opens, so a process-wide `ipcMain` serves every
    //    pane in parallel — `createElectronMainChannel`'s sender filter is
    //    what stops one renderer from reading another's traffic.
    const entryWindow = new BrowserWindow({
      width: 1200,
      height: 800,
      webPreferences: {
        preload: join(bundleDir, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    })

    guardNavigation(entryWindow)

    const channel = createElectronMainChannel(mainIpc, entryWindow.webContents)
    const sessionHost = new SessionHost({
      channel,
      controller: pane.controller,
      runtimeSlot: pane.runtimeSlot,
      project: owner.project,
      scope: pane.scope,
      workspace: owner.workspace,
      onPaneOpened: (nextPane, requestSessionId) => {
        // Another pane was opened from this renderer. The host has already
        // registered it in the workspace; we just need to materialize the
        // window plus channel plus SessionHost for it.
        const target = requestSessionId ?? nextPane.getSession().id
        // The map is keyed by window id, so look up by session id instead —
        // there is at most one window per session by the workspace's invariant.
        if (focusPaneWindow(target)) return
        void openPane(owner, { sessionId: target })
      },
      onPaneClosed: (paneId) => {
        // The host has already closed the pane in its workspace; the window is
        // ours to destroy. Look the window up by the pane that closed rather
        // than assuming it is this callback's own: a renderer can close another
        // tab, and closing over `entry` unconditionally would take down the
        // wrong window. `getSessionMeta()` still answers after
        // `controller.dispose()`, so the scan resolves post-teardown.
        detachPane(findEntryBySessionId(paneId) ?? entry, 'pane-closed')
      },
      onFocusPane: focusPaneWindow,
      onOpenProject: (path) => {
        void openProjectInteractive(path)
      },
      // With several projects open a host's own workspace is a subset of the
      // tabs on screen, so the shell answers instead — from its window map, so
      // every row the renderer draws is a row it can focus.
      describePanes: describeAllPanes,
      // The host has just told its own renderer; the other windows are ours to
      // tell. Fires for a session switch too, which is a topology change even
      // though no pane opened or closed (`paneId` is the session id).
      onPaneListChanged: () => {
        if (entry) broadcastPaneListToOthers(entry)
      },
    })

    entry = { pane, sessionHost, window: entryWindow, project: owner }
    panes.set(entryWindow.id, entry)
    // Tell every other window that the pane list changed. The host will
    // push its own `pane-list` to the originating renderer once it boots;
    // passing `entry` skips that destination so it does not receive two
    // back-to-back updates.
    broadcastPaneListToOthers(entry)

    // The renderer's `close` (window control, Cmd+W, …) flows through
    // `webContents.on('destroyed')`; the channel handler there closes the
    // SessionHost. `detachPane` is idempotent, so the OS path and the
    // host-driven path can both arrive.
    entryWindow.on('closed', () => {
      const held = panes.get(entryWindow.id)
      if (held) detachPane(held, 'window-closed')
    })

    try {
      await entryWindow.loadFile(join(bundleDir, 'renderer', 'index.html'))
    } catch (error) {
      detachPane(entry, 'load-failed')
      throw error
    }

    return entry
  } catch (error) {
    // `openPane` is called from `second-instance`, `activate` and the host
    // callbacks; propagate the failure as a dialog rather than a silent log so
    // the user can act.
    dialog.showErrorBox(
      'Hanekawa could not open a tab',
      error instanceof Error ? error.message : String(error),
    )
    return undefined
  }
}

/**
 * Tears one window down: its `SessionHost`, its pane, the window itself.
 *
 * The single exit path for all three ways a pane can go away (the OS closing the
 * window, a renderer's `close-pane`, a failed `loadFile`), so the project-level
 * bookkeeping in `afterPaneDetached` cannot be reached by only two of them.
 * Idempotent: the map entry is dropped first, and `window.destroy()` re-enters
 * through the `'closed'` handler.
 */
function detachPane(entry: PaneEntry | null, reason: string): void {
  if (!entry) return
  if (panes.get(entry.window.id) !== entry) return
  panes.delete(entry.window.id)
  entry.sessionHost.dispose()
  entry.project.workspace.close(entry.pane)
  if (!entry.window.isDestroyed()) entry.window.destroy()
  broadcastPaneListToOthers(entry)
  afterPaneDetached(entry, reason)
}

/**
 * A project outlives its windows only until this runs.
 *
 * `shutdown()` is the only call that stops background tasks and MCP clients, so
 * a project whose last window is gone has to be shut down here or it keeps child
 * processes alive with no UI able to stop them. Reopening the same project
 * bootstraps it again, which costs a fraction of a second.
 *
 * Skipped entirely while quitting: `teardown()` owns the ordering then, and
 * closing projects from underneath it would race its own pane loop.
 */
function afterPaneDetached(entry: PaneEntry, reason: string): void {
  if (quitting) return
  const stillOpen = [...panes.values()].some((held) => held.project === entry.project)
  if (!stillOpen) void directory.closeProject(entry.project, reason)
  if (panes.size === 0 && process.platform !== 'darwin') app.quit()
}

/**
 * Linear scan for the entry whose pane currently shows a given session id.
 *
 * The `panes` map is keyed by window id, but the host callbacks arrive with a
 * session id (the renderer's `open-pane` / `focus-pane` payload). The workspace
 * guarantees at most one pane per session, so at most one window — a scan is
 * fine, and "scan" is what `paneForSession` already does, so a
 * Map<sessionId, …> would be a duplicate index that drifts on every `/clear`.
 */
function findEntryBySessionId(sessionId: string): PaneEntry | undefined {
  for (const entry of panes.values()) {
    if (entry.pane.getSession().id === sessionId) return entry
  }
  return undefined
}

/**
 * `focus-pane`: bring an existing pane's window forward, whichever project owns
 * it. `false` tells the renderer its tab list is stale.
 */
function focusPaneWindow(paneId: string): boolean {
  const entry = findEntryBySessionId(paneId)
  if (!entry || entry.window.isDestroyed()) return false
  focusWindow(entry.window)
  return true
}

/** The most recently opened window of a project, for "this project is already open". */
function focusProject(project: ProjectEntry): void {
  const owned = [...panes.values()].filter((entry) => entry.project === project)
  const latest = owned.at(-1)
  if (latest && !latest.window.isDestroyed()) focusWindow(latest.window)
}

function focusWindow(window: BrowserWindow): void {
  if (window.isMinimized()) window.restore()
  window.focus()
}

/**
 * Keep every navigation out of the pane's own window.
 *
 * The renderer is a single `loadFile`, so following a link in place would replace
 * the whole UI with a web page and leave the `SessionHost` talking to a renderer
 * that no longer exists. Markdown links (`dom/markdownView.ts`) carry
 * `target="_blank"`, which lands in `setWindowOpenHandler`; `will-navigate`
 * catches the rest (a dragged URL, a same-window link a future view forgets to
 * mark). Both hand `http(s)` to the OS browser and drop anything else — the href
 * already passed `safeHref` in the parser, and this is the second net.
 *
 * Untested, like everything else in this file: `main.ts` cannot be imported under
 * plain node. Verified by smoke only.
 */
function guardNavigation(window: BrowserWindow): void {
  const openExternally = (url: string): void => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
  }

  window.webContents.setWindowOpenHandler(({ url }) => {
    openExternally(url)
    return { action: 'deny' }
  })

  window.webContents.on('will-navigate', (event, url) => {
    event.preventDefault()
    openExternally(url)
  })
}

/**
 * The whole tab topology, across every project.
 *
 * Projected from the *windows* rather than from the workspaces, and the
 * difference matters: a pane is registered in its workspace before its window
 * exists, so describing workspaces would advertise tabs nothing can focus. The
 * field-by-field projection itself lives in `ProjectDirectory.describe` — one
 * copy, shared with whatever the hosts report.
 */
function describeAllPanes(): WirePaneInfo[] {
  return directory.describe([...panes.values()].map((entry) => entry.pane))
}

/**
 * Push the current pane list to every renderer **except** the originating
 * one. The originating host has already pushed its own list via
 * `SessionHost.broadcastPaneList`, so the originating window has the freshest
 * data; the rest of the windows need a fan-out the host cannot perform
 * (it only sees its own channel).
 *
 * `ignoredEntry` is the entry whose host just broadcast — passing it lets us
 * skip the destination without an extra channel-roundtrip check.
 */
function broadcastPaneListToOthers(ignoredEntry: PaneEntry): void {
  const list = describeAllPanes()
  for (const entry of panes.values()) {
    if (entry === ignoredEntry) continue
    if (entry.window.isDestroyed()) continue
    entry.window.webContents.send(ELECTRON_RUNTIME_CHANNEL, {
      type: 'pane-list',
      panes: list,
    })
  }
}

/**
 * MCP trust prompt. `confirmMcpTrust` is awaited inside `bootstrap()`, before
 * any channel exists, so this cannot be a renderer dialog — a native modal is
 * the only thing available this early. Every project asks for its own servers.
 *
 * `showMessageBoxSync` returns the button *index*; it is the async
 * `showMessageBox` that returns `{ response }`. Reading `.response` off the
 * number here used to make this function return `undefined`, which silently
 * rejected every server even when the user clicked Trust.
 */
async function promptTrustMcpServer(
  name: string,
  server: McpServerConfig,
): Promise<boolean> {
  const detail =
    server.transport === 'stdio'
      ? `Command: ${[server.command, ...(server.args ?? [])].filter(Boolean).join(' ')}`
      : server.url
        ? `URL: ${server.url}`
        : 'Unknown transport'
  const clicked = dialog.showMessageBoxSync({
    type: 'question',
    buttons: ['Trust', 'Reject'],
    // Both default to Reject: a dismissed dialog must not grant trust.
    defaultId: 1,
    cancelId: 1,
    title: 'Trust MCP server',
    message: `Trust MCP server "${name}"?`,
    detail,
  })
  return clicked === 0
}

/**
 * Resolve a project directory from a command line.
 *
 * The first instance defaults to `process.cwd()` so it launches in the shell's
 * directory; a second instance passes its own argv and working directory, which
 * is what makes `hanekawa` in another folder open that folder's project.
 * `--cwd=…` overrides either.
 */
function resolveCwd(argv: readonly string[] = process.argv, fallback: string = process.cwd()): string {
  const flag = argv.find((arg) => arg.startsWith('--cwd='))
  if (flag) {
    const value = flag.slice('--cwd='.length)
    if (existsSync(value)) return value
  }
  return fallback
}
