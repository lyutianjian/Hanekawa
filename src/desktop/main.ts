/**
 * The Electron main process.
 *
 * Single window, N live panes. One `BrowserWindow` owns one lane multiplexer
 * over its IPC channel; each pane is a lane carrying an untouched
 * `SessionHost`, and the reserved `__shell` lane carries a `ShellHost` — the
 * class every lane/project decision lives in, because nothing in this file is
 * testable (`app.requestSingleInstanceLock()` runs at module top level, so
 * `main.ts` cannot even be imported under plain node). What stays here: the
 * `BrowserWindow`'s lifecycle, the native dialogs, and `bootstrap()` — the
 * shell owns the MCP trust prompt and the error boxes, the same split
 * `ProjectDirectory` already draws.
 *
 * Lifecycle:
 *  1. `openProject(cwd)` is the only way a project comes into existence, and
 *     the first project goes through it exactly like the fifth. Inside it,
 *     `bootstrap()` runs with a synchronous `confirmMcpTrust` that drives
 *     `dialog.showMessageBoxSync` for each untrusted MCP server — this fires
 *     before any channel exists, the only place a pre-channel prompt can live.
 *  2. `ensureShell()` builds the one window there is, wires the transport,
 *     the mux and the `ShellHost`, then loads the page. The initial lane opens
 *     after the window is up: the renderer's startup pulls the topology with
 *     `panes` rather than trusting anything posted before it attached
 *     (Electron drops pre-load IPC), so the ordering is a convenience, not a
 *     correctness requirement.
 *  3. A project is shut down when its last lane closes (`ShellHost.detachLane`)
 *     — `ProjectRuntime.shutdown` is the only call that stops background tasks
 *     and MCP clients, so a lane-less project would leave child processes
 *     running with nothing on screen to stop them.
 *  4. On `before-quit` we tear every lane down in order and wait for it, then
 *     shut every project down. `window-all-closed` quits only when there are no
 *     panes left.
 *
 * Two keys, and they are not interchangeable: lane keys are minted by the
 * `ShellHost` and never move (session ids travel under `/clear` and `/resume`),
 * and the project map inside `ProjectDirectory` is keyed by the normalized
 * project root.
 *
 * The `node:fs` imports and the wall-clock commands stay here, never in the
 * renderer bundle.
 */
import { app, BrowserWindow, dialog, ipcMain, Menu, shell as electronShell } from 'electron'
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
import { createLaneMux } from '../runtime/protocol/laneChannel.js'
import type { RuntimeHost } from '../runtime/types.js'
import { ShellHost } from './shellHost.js'
import { openInEditor } from './openInEditor.js'
import {
  createElectronMainChannel,
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

/**
 * The native title-bar overlay, per theme.
 *
 * The one place in the app that spells colours outside `styles.css`, and it has
 * to be: these are painted by Windows into chrome the document does not reach,
 * so no stylesheet rule and no renderer token can describe them. Kept in step
 * with `--surface-base` / `--text-secondary` by hand — a drift here shows up as
 * a three-button strip that does not match the frame under it.
 */
const WINDOW_CHROME = {
  dark: { color: '#0f0f11', symbolColor: '#9aa0aa', height: 40 },
  light: { color: '#f3f3f5', symbolColor: '#686b75', height: 40 },
} as const

// A plain annotation rather than `as unknown as`: `ipcMain` really is
// assignable to `MainSideIpc`, and letting the compiler confirm that is what
// keeps the structural types honest about the Electron API.
const mainIpc: MainSideIpc = ipcMain

/** The one window, its mux, and the host that owns every lane decision. */
interface Shell {
  window: BrowserWindow
  host: ShellHost<RuntimeHost, SessionPane, SessionWorkspace>
}

/** Every open project. All decisions that used to be module-level variables live here. */
const directory = new ProjectDirectory()
/** The single window's shell, once the first project has opened it. */
let shell: Shell | undefined
let quitting = false
/** Lane keys are minted here so they are monotonic for the process lifetime. */
let laneCounter = 0

if (!app.requestSingleInstanceLock()) {
  // `app.quit()` does not stop module evaluation, so everything below has to
  // stay inside the else — otherwise a second instance runs a whole
  // `bootstrap()` (MCP connects, store init) on a process that is exiting.
  app.quit()
} else {
  app.on('second-instance', (_event, argv, workingDirectory) => {
    // A second launch is a request for *that* directory's project: open it if it
    // is new, focus it if it is already here. There is only one window now, so
    // focusing it is the whole of "bring Hanekawa to the front" — the project
    // itself gets its newest lane activated through the shell protocol.
    if (shell && !shell.window.isDestroyed()) focusWindow(shell.window)
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
    // On macOS the dock icon survives a window close; projects do not (their
    // last lane died with the window), so this reopens whichever entry is left
    // — a fresh bootstrap, the same cost as the first open.
    if (BrowserWindow.getAllWindows().length === 0) {
      const first = directory.entries()[0]
      if (first) void openProject(first.cwd)
    }
  })

  void app.whenReady().then(async () => {
    // No application menu (5g): the window is frameless, and Electron's default
    // menu is an English File/Edit/View/Window bar in an otherwise Chinese
    // interface. The renderer draws 文件 / 视图 / 帮助 in the title bar instead,
    // and the editing accelerators a textarea needs are the platform's own.
    // Not on darwin, where removing the menu also removes 退出 and the standard
    // clipboard roles, and the traffic lights are drawn by the OS regardless.
    if (process.platform !== 'darwin') Menu.setApplicationMenu(null)
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
 * Brings a project into the process, or focuses its newest lane if it is
 * already here.
 *
 * The idempotence is the point: `directory.add` refuses a duplicate root, since
 * two `ProjectRuntime`s over one `.myagent/` means two `SessionStore`s appending
 * to the same JSONL files. Checking first turns "open this project" into a safe
 * request no matter how often the user makes it.
 *
 * Throws for bootstrap failures (the startup path wants an error box and a
 * quit); a failure *after* bootstrap is reported here and the project closed —
 * a project nothing on screen can reach is a set of child processes with no UI
 * to stop them.
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
  // scope without rebuilding it (which `open` would). The initial lane resolves
  // to this adopted pane through `paneForSession`, so no ghost pane is left
  // behind in the workspace.
  workspace.adopt(project)
  const entry = directory.add(project, workspace)

  try {
    const built = await ensureShell()
    await built.host.openLane(entry, { sessionId: session.id })
  } catch (error) {
    dialog.showErrorBox(
      'Hanekawa could not open a tab',
      error instanceof Error ? error.message : String(error),
    )
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

/**
 * Builds the single window: transport, lane mux, `ShellHost`, page — in that
 * order, so every lane that ever opens has a host to land on before the
 * renderer exists.
 *
 * Idempotent: the second and every later project share the first window.
 */
async function ensureShell(): Promise<Shell> {
  if (shell) return shell

  const window = new BrowserWindow({
    width: 1200,
    height: 800,
    // Frameless chrome (5g): the renderer draws the title bar — the rail toggle
    // and the Chinese menus — and Windows keeps drawing its own three buttons
    // into `titleBarOverlay`, so no window-control IPC has to exist at all.
    // `backgroundColor` is what the frame is painted with before the first
    // frame arrives; without it the app opens as a white flash.
    backgroundColor: WINDOW_CHROME.dark.color,
    titleBarStyle: 'hidden',
    ...(process.platform === 'darwin' ? {} : { titleBarOverlay: WINDOW_CHROME.dark }),
    webPreferences: {
      preload: join(bundleDir, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  guardNavigation(window)

  // One transport for the whole window; panes are lanes on it, not senders of
  // their own — which is the whole reason the lane mux exists.
  const channel = createElectronMainChannel(mainIpc, window.webContents)
  const mux = createLaneMux(channel)

  // The occupant factory closes the loop: the ShellHost owns lane bookkeeping,
  // and each lane's occupant is a SessionHost wired straight back into it.
  // `shellHost` is assigned below; every callback here fires long after.
  let shellHost: ShellHost<RuntimeHost, SessionPane, SessionWorkspace> | undefined
  const host = new ShellHost<RuntimeHost, SessionPane, SessionWorkspace>({
    mux,
    directory,
    nextLaneKey: () => `${++laneCounter}`,
    createOccupant: (attach) => {
      const sessionHost = new SessionHost({
        channel: attach.channel,
        controller: attach.pane.controller,
        runtimeSlot: attach.pane.runtimeSlot,
        project: attach.project.project,
        scope: attach.pane.scope,
        workspace: attach.project.workspace,
        // A pane opened by this lane's host (`open-pane` from its renderer):
        // the host has already registered it in the workspace, the shell
        // attaches its lane — dedup on pane identity activates instead.
        onPaneOpened: (pane) => {
          shellHost?.attachPane(attach.project, pane)
        },
        onPaneClosed: (paneId) => {
          shellHost?.detachLaneBySessionId(paneId, 'pane-closed')
        },
        // The renderer no longer sends `focus-pane` (activation is local to
        // the single window), but the command stays on the wire for the TUI —
        // and it maps naturally onto "activate that pane's lane".
        onFocusPane: (paneId) => {
          const lane = shellHost?.laneForSessionId(paneId)
          if (lane === undefined) return false
          shellHost?.requestActivate(lane)
          return true
        },
        onOpenProject: (path) => {
          void openProjectInteractive(path)
        },
        // The shell answers from its lane map so every row the renderer draws
        // is a row it can switch to.
        describePanes: () => shellHost?.describeLanes() ?? [],
        // The host just told its own lane; every other lane and the shell lane
        // are ours to tell.
        onPaneListChanged: () => {
          shellHost?.broadcastLanes()
        },
      })
      // Delegated one for one rather than handing the `SessionHost` over as the
      // occupant: `LaneOccupant` is what `ShellHost` is allowed to say to a
      // lane, and keeping it a three-method view is what stops the shell from
      // reaching into a session's runtime.
      return {
        dispose: () => sessionHost.dispose(),
        refreshAfterConfigChange: (options) => {
          sessionHost.refreshAfterConfigChange(options)
        },
        refreshSessionMeta: (session) => {
          sessionHost.refreshSessionMeta(session)
        },
      }
    },
    onOpenProject: (path) => {
      void openProjectInteractive(path)
    },
    // Returned rather than fired-and-forgotten: the shell awaits it so "code is
    // not installed" comes back as a `fail` the renderer writes into the
    // transcript, instead of a native box no test can see.
    onOpenInEditor: (cwd) => openInEditor(cwd),
    // The overlay is drawn by the OS, so the renderer — where the theme
    // preference lives — cannot repaint it itself. `setTitleBarOverlay` only
    // exists on Windows; elsewhere the command still answers `ok`, because the
    // shell treats a missing overlay as "this platform has none".
    onWindowTheme: (theme) => {
      if (process.platform === 'darwin') return
      window.setTitleBarOverlay(WINDOW_CHROME[theme])
    },
    isQuitting: () => quitting,
    onAllLanesClosed: () => {
      // The last lane of the single window is the single-window equivalent of
      // "the last window closed". Non-darwin quits, exactly as it always did;
      // darwin keeps the empty window — its tab bar still offers new tabs and
      // "Open project", which the 4b sidebar builds on.
      if (process.platform !== 'darwin') app.quit()
    },
  })
  shellHost = host

  const built: Shell = { window, host }
  shell = built

  // The renderer is gone: every lane dies with it. The transport is already
  // dead by the time 'closed' fires, so `detachLane`'s control frames are
  // dropped by the mux and the local cleanup is the whole job.
  window.on('closed', () => {
    if (shell !== built) return
    shell = undefined
    for (const key of host.laneKeys()) host.detachLane(key, 'window-closed')
  })

  try {
    await window.loadFile(join(bundleDir, 'renderer', 'index.html'))
  } catch (error) {
    // The one window failed to build: nothing can be shown at all.
    shell = undefined
    if (!window.isDestroyed()) window.destroy()
    throw error
  }

  return built
}

async function teardown(): Promise<void> {
  // Lanes first, in the fixed order inside `workspace.close`
  // (`interrupt('exit')` → controller → slot → scope), then the projects: a
  // project shut down under a live pane pulls the tools out from beneath a turn
  // that is still draining. `detachLane` skips project shutdown while quitting
  // — `shutdownAll` owns that ordering.
  if (shell) {
    for (const key of shell.host.laneKeys()) shell.host.detachLane(key, 'app-quit')
    if (!shell.window.isDestroyed()) shell.window.destroy()
  }
  await directory.shutdownAll('app-quit')
}

/**
 * An already-open project: focus the window and activate its newest lane —
 * the single-window equivalent of raising that project's window.
 */
function focusProject(project: ProjectEntry): void {
  const built = shell
  if (!built || built.window.isDestroyed()) return
  focusWindow(built.window)
  const lanes = built.host.describeLanes().filter((lane) => lane.projectRoot === project.root)
  const latest = lanes.at(-1)
  if (latest) built.host.requestActivate(latest.lane)
}

function focusWindow(window: BrowserWindow): void {
  if (window.isMinimized()) window.restore()
  window.focus()
}

/**
 * Keep every navigation out of the pane's own window.
 *
 * The renderer is a single `loadFile`, so following a link in place would replace
 * the whole UI with a web page and leave every `SessionHost` talking to a
 * renderer that no longer exists. Markdown links (`dom/markdownView.ts`) carry
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
    if (/^https?:\/\//i.test(url)) void electronShell.openExternal(url)
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
