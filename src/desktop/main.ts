/**
 * The Electron main process.
 *
 * Multi-pane desktop shell: one `BrowserWindow` per session, all sharing the
 * same `ProjectRuntime`. The composition mirrors `src/tui/entrypoints/tui.tsx`
 * — `bootstrap()` returns the merged `RuntimeHost`, a `SessionWorkspace` keeps
 * the panes alive, and `SessionHost` does the runtime/protocol work for each
 * one. Everything TUI-shaped is not here; everything renderer-shaped is not here.
 *
 * Lifecycle:
 *  1. `bootstrap()` runs with a synchronous `confirmMcpTrust` that drives
 *     `dialog.showMessageBoxSync` for each untrusted MCP server — this fires
 *     before any channel exists, the only place a pre-channel prompt can live.
 *  2. `openPane({ sessionId?, title? })` builds the window, wires the channel
 *     and constructs `SessionHost` **before** loading the page. The channel is
 *     what makes the attach lossless, and there is deliberately no ready
 *     handshake. The same routine opens the first pane and every subsequent
 *     tab, so a renderer-initiated `open-pane` reaches the same wiring.
 *  3. On `before-quit` we tear down every pane in order and wait for it,
 *     because `ProjectRuntime.shutdown` is the only call site that stops
 *     background tasks.
 *  4. `window-all-closed` quits only when there are no panes left.
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
import {
  bootstrap,
  RuntimeStartupError,
  type RuntimeHost,
} from '../runtime/index.js'
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
 */
const panes = new Map<number, PaneEntry>()
let host: RuntimeHost | null = null
let workspace: SessionWorkspace | null = null
let quitting = false

if (!app.requestSingleInstanceLock()) {
  // `app.quit()` does not stop module evaluation, so everything below has to
  // stay inside the else — otherwise a second instance runs a whole
  // `bootstrap()` (MCP connects, store init) on a process that is exiting.
  app.quit()
} else {
  app.on('second-instance', () => {
    // A second instance opens a new tab in the existing window rather than a
    // second window — keeps the workspace as the single shared surface.
    const focused = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    if (focused) {
      if (focused.isMinimized()) focused.restore()
      focused.focus()
    }
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
    // `host.shutdown()` is the only place background tasks get stopped, so
    // exiting out from under it leaks child processes. Cancel this quit, drain,
    // then quit again — the guard above lets the second pass through.
    event.preventDefault()
    void teardown().finally(() => {
      app.quit()
    })
  })

  app.on('activate', () => {
    // On macOS the dock icon survives a window close; if the workspace is still
    // alive but the last window was closed, spawn a fresh tab so the user is
    // not staring at an empty dock.
    if (BrowserWindow.getAllWindows().length === 0 && host && workspace) {
      void openPane({})
    }
  })

  void app.whenReady().then(async () => {
    try {
      await main()
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

async function main(): Promise<void> {
  const cwd = resolveCwd()

  const store = new SessionStore(cwd)
  await store.init()

  // `list()` is sorted newest-first, so `at(0)` resumes the most recent
  // session. A project that has never run the agent gets an in-memory draft,
  // exactly as the TUI does — nothing touches disk until the first `message`
  // record, so this costs nothing if the user closes the window immediately.
  const sessions = await store.list()
  const session = sessions.at(0) ?? store.createDraft()

  host = await bootstrap({
    cwd,
    store,
    session,
    confirmMcpTrust: promptTrustMcpServer,
  })

  logDiagnostics(host.diagnostics)
  workspace = new SessionWorkspace(host)
  // The bootstrap session is the first pane; `adopt` registers the existing
  // scope without rebuilding it (which `open` would). Pass the resumed
  // session id so `openPane` resolves to the adopted pane rather than minting
  // a fresh draft and leaving a window-less ghost behind in the workspace.
  workspace.adopt(host)
  await openPane({ sessionId: session.id })
}

async function teardown(): Promise<void> {
  // Closing every pane is the only call that stops background tasks per-pane.
  // The fixed four-step order inside `workspace.close` keeps each scope
  // shutdown ordered: `interrupt('exit')` → controller → slot → scope.
  for (const entry of [...panes.values()]) {
    entry.sessionHost.dispose()
    workspace?.close(entry.pane)
    if (!entry.window.isDestroyed()) entry.window.destroy()
  }
  panes.clear()
  if (host) {
    await host.shutdown('app-quit')
    host = null
  }
  workspace = null
}

/**
 * Opens a new tab.
 *
 * The argument shape matches `HostCommand.open-pane`: omit `sessionId` to mint
 * a fresh draft (rare from this entry point — the bootstrap already does
 * that), or pass one to retarget. The shell's role is the same either way:
 * build a window, build a `RuntimeChannel` over it, attach a `SessionHost`.
 */
async function openPane(options: { sessionId?: string; title?: string }): Promise<void> {
  if (!host || !workspace) {
    throw new Error('Runtime was not built before a pane was opened')
  }

  let entry: PaneEntry | null = null

  try {
    // 1. Find or build the pane for the requested session.
    let pane: SessionPane
    if (options.sessionId) {
      const existing = workspace.paneForSession(options.sessionId)
      if (existing) {
        pane = existing
      } else {
        const session = await host.store.resolve(options.sessionId)
        if (!session) throw new Error(`Session not found: ${options.sessionId}`)
        pane = await workspace.open(session)
      }
    } else {
      // A fresh draft. Mirrors `bootstrap()`: `store.createDraft` is in-memory
      // until the first message record.
      const scope = await host.openScope(host.store.createDraft(options.title))
      pane = workspace.adopt(scope, {})
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
      project: host,
      scope: pane.scope,
      workspace,
      onPaneOpened: (nextPane, requestSessionId) => {
        // Another pane was opened from this renderer. The host has already
        // registered it in the workspace; we just need to materialize the
        // window plus channel plus SessionHost for it.
        const target = requestSessionId ?? nextPane.getSession().id
        // The map is keyed by window id, so look up by session id instead —
        // there is at most one window per session by the workspace's invariant.
        const existing = findEntryBySessionId(target)
        if (existing && !existing.window.isDestroyed()) {
          if (existing.window.isMinimized()) existing.window.restore()
          existing.window.focus()
          return
        }
        void openPane({ sessionId: target })
      },
      onPaneClosed: () => {
        // The host has already removed the pane from the workspace; we just
        // need to destroy the window. By the time this fires, `entry` is the
        // entry for THIS callback's host (the closure captures it), so the
        // window id is the right key regardless of any `/clear` that the
        // pane already went through.
        if (!entry) return
        if (!entry.window.isDestroyed()) entry.window.destroy()
        // The 'closed' lifecycle handler will delete from `panes` and run
        // the last-pane exit check, so this callback stays focused on the
        // single responsibility of tearing the window down.
      },
    })

    entry = { pane, sessionHost, window: entryWindow }
    panes.set(entryWindow.id, entry)
    // Tell every other window that the pane list changed. The host will
    // push its own `pane-list` to the originating renderer once it boots;
    // passing `entry` skips that destination so it does not receive two
    // back-to-back updates.
    broadcastPaneListToOthers(entry)

    // The renderer's `close` (window control, Cmd+W, …) flows through
    // `webContents.on('destroyed')`; the channel handler there closes the
    // SessionHost. We also detach the host from the map right here so a
    // subsequent 'closed' event for the same window is a no-op.
    entryWindow.on('closed', () => {
      const held = panes.get(entryWindow.id)
      if (!held) return
      held.sessionHost.dispose()
      workspace?.close(held.pane)
      panes.delete(entryWindow.id)
      broadcastPaneListToOthers(held)
      if (panes.size === 0 && process.platform !== 'darwin') {
        app.quit()
      }
    })

    try {
      await entryWindow.loadFile(join(bundleDir, 'renderer', 'index.html'))
    } catch (error) {
      entry.sessionHost.dispose()
      workspace.close(entry.pane)
      if (!entry.window.isDestroyed()) entry.window.destroy()
      panes.delete(entryWindow.id)
      broadcastPaneListToOthers(entry)
      throw error
    }
  } catch (error) {
    // `openPane` is called from `second-instance` and `activate`; propagate
    // the failure as a dialog rather than a silent log so the user can act.
    dialog.showErrorBox(
      'Hanekawa could not open a tab',
      error instanceof Error ? error.message : String(error),
    )
  }
}

/**
 * Linear scan for the entry whose pane currently shows a given session id.
 *
 * The `panes` map is keyed by window id, but `onPaneOpened` arrives with a
 * session id (the renderer's `open-pane` payload). The workspace guarantees
 * at most one pane per session, so at most one window — a scan is fine, and
 * "scan" is what `paneForSession` already does, so a Map<sessionId, ...>
 * would be a duplicate index that drifts on every `/clear`.
 */
function findEntryBySessionId(sessionId: string): PaneEntry | undefined {
  for (const entry of panes.values()) {
    if (entry.pane.getSession().id === sessionId) return entry
  }
  return undefined
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
 * Project the live pane set into the renderer's `WirePaneInfo[]` shape.
 *
 * Field-by-field rather than a spread: `SessionPane` carries the controller
 * and runtime slot, and the renderer reads only `paneId` / `sessionId` /
 * `sessionTitle`. Anything else is a privacy surface.
 */
function collectAllPanes(): WirePaneInfo[] {
  const out: WirePaneInfo[] = []
  for (const entry of panes.values()) {
    const session = entry.pane.getSession()
    const info: WirePaneInfo = { paneId: session.id, sessionId: session.id }
    if (session.title !== undefined) info.sessionTitle = session.title
    out.push(info)
  }
  return out
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
  const list = collectAllPanes()
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
 * the only thing available this early.
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
 * Resolve the working directory from argv or environment.
 *
 * The TUI defaults to `process.cwd()` so it launches in the shell's directory,
 * and we keep that. `--cwd=…` overrides it; "open another project" is a
 * stage-3 feature.
 */
function resolveCwd(): string {
  const flag = process.argv.find((arg) => arg.startsWith('--cwd='))
  if (flag) {
    const value = flag.slice('--cwd='.length)
    if (existsSync(value)) return value
  }
  return process.cwd()
}
