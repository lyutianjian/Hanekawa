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
 *  1. `ensureProject(cwd)` is the only way a project comes into existence, and
 *     the first project goes through it exactly like the fifth. Inside it,
 *     `bootstrap()` runs with a synchronous `confirmMcpTrust` that drives
 *     `dialog.showMessageBoxSync` for each untrusted MCP server — this fires
 *     before any channel exists, the only place a pre-channel prompt can live.
 *     Every project is entered through a *new empty session* — `openProject`
 *     from startup/`--cwd=`/the picker, or the shell's on-demand path when a
 *     history row of a not-yet-open project is clicked. Startup resolves the
 *     directory from the "added projects" registry (the project of the most
 *     recent session anywhere), falling back to the global workspace — the
 *     home directory, whose records land in `~/.myagent`. The registry keeps
 *     *added* order and re-opening does not move an entry, because it is also
 *     the sidebar's group order.
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
 *     shut every project down — but only up to `SHUTDOWN_DEADLINE_MS`. The
 *     window is destroyed in the first half of `teardown()`, so a project that
 *     never finishes draining used to leave a running process with nothing on
 *     screen. `window-all-closed` quits only when there are no panes left.
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
import { SessionStore, type SessionMeta } from '../sessions/service.js'
import { logDiagnostics } from '../harness/diagnostics.js'
import type { McpServerConfig } from '../services/mcp/index.js'
import { bootstrap, RuntimeStartupError } from '../runtime/index.js'
import {
  ProjectDirectory,
  SHUTDOWN_DEADLINE_MS,
  type ProjectEntry,
} from '../runtime/projectDirectory.js'
import { isGlobalWorkspaceRoot } from '../utils/paths.js'
import {
  recordProjectOpen,
  resolveStartupRoot,
  loadRecentProjects,
  forgetRecentProject,
} from './recentProjects.js'
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
  // `--surface-base`, the frame's own rung (design_guidance 六.1): the overlay
  // strip sits at the window's right edge, on the same flat base the title bar
  // and sidebar are painted over — there has been no wash to fade out since
  // the 2026 re-skin, so the strip matches by being the same colour, full stop.
  // `height` is `#titlebar`'s in `styles.css`; the OS paints its three buttons
  // onto the same band, so the two numbers move together or the caption row and
  // the controls stop sharing a centre line.
  dark: { color: '#262523', symbolColor: '#a19a90', height: 40 },
  light: { color: '#f2efe9', symbolColor: '#6b655c', height: 40 },
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
    // itself gets its newest lane activated through the shell protocol. The
    // launch directory is explicit intent here, unlike a first launch's bare
    // `process.cwd()`.
    if (shell && !shell.window.isDestroyed()) focusWindow(shell.window)
    void openProjectInteractive(explicitCwd(argv) ?? workingDirectory)
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
    // — and when nothing is, the registry's answer, the same resolution a
    // fresh launch would make.
    if (BrowserWindow.getAllWindows().length === 0) {
      const first = directory.entries()[0]
      if (first) {
        void openProject(first.cwd)
      } else {
        void resolveStartupRoot().then((resolution) => openProject(resolution.root))
      }
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
      await openProject(await resolveStartupProject())
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
 * Brings a project into the process — bootstrap, pane, directory, registry —
 * without opening a lane.
 *
 * Split from `openProject` because two callers need the halves separately: the
 * sidebar's history opens a *named* session of a not-yet-open project
 * (bootstrapped over that session, so the project's first pane is the pane the
 * click asked for, never a throwaway), while startup and "open project…" want
 * a fresh draft.
 *
 * Idempotent: `directory.add` refuses a duplicate root, since two
 * `ProjectRuntime`s over one `.myagent/` means two `SessionStore`s appending
 * to the same JSONL files, so an already-open project is handed back as-is —
 * which is also what makes repeated "open this project" requests safe.
 *
 * Throws for bootstrap failures; the startup path wants an error box and a
 * quit.
 */
async function ensureProject(
  cwd: string,
  options: { sessionId?: string } = {},
): Promise<{ entry: ProjectEntry; session: SessionMeta | undefined }> {
  const open = directory.get(cwd)
  if (open) return { entry: open, session: undefined }

  const store = new SessionStore(cwd)
  await store.init()

  // Every entry into a project is a *new* session — startup never resumes
  // history (`sessions.at(0)` is gone). A history row names the session it
  // wants, so the bootstrap scope is built over it; anything else gets an
  // in-memory draft, and nothing touches disk until the first `message`
  // record either way.
  let session: SessionMeta
  if (options.sessionId !== undefined) {
    const named = await store.resolve(options.sessionId)
    if (!named) throw new Error(`Session not found: ${options.sessionId}`)
    session = named
  } else {
    session = store.createDraft()
  }

  const project = await bootstrap({
    cwd,
    store,
    session,
    confirmMcpTrust: promptTrustMcpServer,
  })

  logDiagnostics(project.diagnostics)
  const workspace = new SessionWorkspace(project)
  // The bootstrap session is the first pane; `adopt` registers the existing
  // scope without rebuilding it (which `open` would). Handing the session back
  // alongside the entry is what lets `openProject` open its lane *on this
  // pane*, rather than minting a second draft and leaving this one lane-less.
  workspace.adopt(project)
  const entry = directory.add(project, workspace)

  // The registry is the desktop's memory of "added projects": it decides the
  // next launch's startup directory and the sidebar's full history *and its
  // order*, which is why this write appends rather than hoists. The global
  // workspace is implicit — always a startup candidate, never a member.
  if (!isGlobalWorkspaceRoot(cwd)) await recordProjectOpen(cwd)
  return { entry, session }
}

/**
 * Opens a project and lands in a new empty session — the path every explicit
 * "open this project" takes: startup, `--cwd=`, a second instance, the
 * directory picker. An already-open project is focused instead.
 */
async function openProject(cwd: string): Promise<void> {
  const open = directory.get(cwd)
  if (open) {
    focusProject(open)
    return
  }

  const { entry, session } = await ensureProject(cwd)
  try {
    const built = await ensureShell()
    // The bootstrap pane (over the fresh draft) is the lane's pane — exactly
    // one pane per open, never a ghost draft pane left in the workspace.
    await built.host.openLane(entry, session !== undefined ? { sessionId: session.id } : {})
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
async function promptForDirectory(options: {
  title: string
  buttonLabel: string
}): Promise<string | undefined> {
  const result = await dialog.showOpenDialog({
    title: options.title,
    buttonLabel: options.buttonLabel,
    properties: ['openDirectory', 'createDirectory'],
  })
  if (result.canceled) return undefined
  return result.filePaths[0]
}

function promptForProjectDirectory(): Promise<string | undefined> {
  return promptForDirectory({ title: 'Open project', buttonLabel: 'Open' })
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
    // Sized for the layout rather than for the screen: the transcript reads in a
    // 1100px column and the sidebar is 268 of the rest, so a wider default only
    // buys canvas nobody writes into. The minimums are where the two columns and
    // the composer's action bar still fit without wrapping.
    width: 1080,
    height: 720,
    minWidth: 900,
    minHeight: 620,
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
        activeModelKey: () => sessionHost.activeModelKey(),
      }
    },
    onOpenProject: (path) => {
      void openProjectInteractive(path)
    },
    onPickDirectory: (options) => promptForDirectory(options),
    // The sidebar's history is every *added* project, most of them without an
    // open runtime — the registry is the source, read live so a project added
    // by another window (or a stale root) is never cached wrong.
    knownProjects: async () =>
      (await loadRecentProjects()).filter(
        (cwd) => !isGlobalWorkspaceRoot(cwd) && existsSync(cwd),
      ),
    // A history row of a not-yet-open project bootstraps it on demand, over
    // the session the click named.
    ensureProject: async (cwd, options) => (await ensureProject(cwd, options)).entry,
    // The write half of "从侧边栏移除": registry only. The shell has already
    // closed the lanes by the time this runs, and nothing on disk is deleted —
    // opening the directory again restores the group and its history.
    onForgetProject: async (cwd) => {
      await forgetRecentProject(cwd)
    },
    // Returned rather than fired-and-forgotten: the shell awaits it so "code is
    // not installed" comes back as a `fail` the renderer writes into the
    // transcript, instead of a native box no test can see. A `target` (T15) is
    // one search hit's file and line, already resolved and bounded host-side.
    onOpenInEditor: (cwd, target) => openInEditor(cwd, target),
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
  // Bounded, because `before-quit` has already cancelled the real quit and is
  // waiting on this: an unbounded await here is how "the window closed but the
  // process is still running" happens. Timing out is not a failure to report to
  // the user — there is no UI left — so it goes to stderr like every other
  // main-process diagnostic.
  const outcome = await directory.shutdownAll('app-quit', { timeoutMs: SHUTDOWN_DEADLINE_MS })
  if (outcome === 'timed-out') {
    console.error(`[hanekawa] shutdown did not drain in ${SHUTDOWN_DEADLINE_MS}ms; quitting anyway`)
  }
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
 * The `--cwd=` flag, when it names a directory that exists.
 *
 * Explicit only: the launch's own working directory is deliberately *not* a
 * candidate anywhere else — a shortcut whose working directory is the install
 * folder, or a terminal sitting anywhere else, is not a statement about which
 * project to open.
 */
function explicitCwd(argv: readonly string[] = process.argv): string | undefined {
  const flag = argv.find((arg) => arg.startsWith('--cwd='))
  if (!flag) return undefined
  const value = flag.slice('--cwd='.length)
  return existsSync(value) ? value : undefined
}

/**
 * Where a fresh launch lands.
 *
 * An explicit `--cwd=` wins. Otherwise the registry's answer to
 * “最近一次会话的目录”： the project whose newest session is the newest
 * anywhere, the most recently added project when nothing has sessions yet, or
 * the global workspace (the home directory) when no project has ever been
 * added — the welcome-screen state whose records land in `~/.myagent`.
 */
async function resolveStartupProject(): Promise<string> {
  const explicit = explicitCwd()
  if (explicit !== undefined) return explicit
  return (await resolveStartupRoot()).root
}
