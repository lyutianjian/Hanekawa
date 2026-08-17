import type { RuntimeChannel } from '../../runtime/protocol/channel.js'

/**
 * The Electron transport, described structurally rather than by importing
 * `electron`.
 *
 * Two reasons, in order of importance. First, `main.ts` is the only file in
 * `src/desktop/` that may hold the real `electron` module, so this file stays
 * importable from a plain-node test process. Second, the shapes below are
 * narrow enough to mock.
 *
 * The rule learned the hard way: **every signature here must match real
 * Electron, not what a mock finds convenient.** Three of these declarations
 * used to be wrong — `ipc.on` was typed as if it returned an unsubscriber,
 * and the main-side target was typed with the DOM's `addEventListener` — and
 * because the only consumers were `as unknown as` casts in `main.ts` plus a
 * purpose-built mock, both survived a clean `tsc` and would have thrown on
 * first launch. The types are now assignable *from* the real Electron objects,
 * so `main.ts` assigns them without a cast and the compiler checks the claim.
 */

/**
 * `webContents.send` — the main→renderer direction.
 *
 * Holding just `send` (rather than the whole `WebContents`) is what makes the
 * channel mockable, and it is also what `IpcMainEvent.sender` is compared
 * against for pane isolation.
 */
export interface MainSideSend {
  send(channel: string, ...args: unknown[]): void
}

/**
 * What `ipcMain` hands a listener. Real Electron passes an `IpcMainEvent`,
 * whose `sender` is the `WebContents` that posted — that is the field the
 * pane filter reads.
 */
export interface MainSideEvent {
  readonly sender: MainSideSend
}

export type MainIpcListener = (event: MainSideEvent, ...args: unknown[]) => void

/**
 * The slice of `ipcMain` the channel needs.
 *
 * `on` returns `void` here on purpose: real `ipcMain.on` returns `this`
 * (`electron.d.ts:8959`) for chaining, **not** an unsubscriber. Teardown goes
 * through `removeListener`, which is the API that actually exists.
 */
export interface MainSideIpc {
  on(channel: string, listener: MainIpcListener): void
  removeListener(channel: string, listener: MainIpcListener): void
}

/**
 * The main side's handle on one renderer: post to it, and learn when it dies.
 *
 * `on('destroyed')`, not `addEventListener('destroyed')` — a `WebContents` is
 * `class WebContents extends NodeEventEmitter`, and has no `addEventListener`
 * at all (the only one in `electron.d.ts` belongs to `WebviewTag`).
 *
 * `BrowserWindow.on('closed')` is deliberately not part of this: closing the
 * window already destroys its `webContents`, so one listener covers both.
 * `fireClose` is idempotent regardless.
 */
export interface MainSideTarget extends MainSideSend {
  on(event: 'destroyed', listener: () => void): void
  removeListener(event: 'destroyed', listener: () => void): void
}

/** What `ipcRenderer` hands a listener; the renderer never inspects it. */
export interface RendererSideEvent {
  readonly sender: unknown
}

export type RendererIpcListener = (event: RendererSideEvent, ...args: unknown[]) => void

/**
 * The slice of `ipcRenderer` the preload needs.
 *
 * Available to a sandboxed preload: `ipcRenderer` and `contextBridge` are both
 * on Electron's sandbox allowlist, which is exactly what `preload.ts` relies
 * on. Same `on`/`removeListener` asymmetry as `MainSideIpc` — real
 * `ipcRenderer.on` also returns `this` (`electron.d.ts:9202`).
 */
export interface RendererSideIpc {
  send(channel: string, ...args: unknown[]): void
  on(channel: string, listener: RendererIpcListener): void
  removeListener(channel: string, listener: RendererIpcListener): void
}

/**
 * The wired-up channel name shared by main and renderer.
 *
 * One literal, not a parameter, so a typo on either side fails the build
 * rather than the user.
 *
 * There is deliberately no `__ready` handshake constant and no `__close`
 * channel. `nodeChannel.ts` needs a ready handshake because a forked child may
 * not have registered its listener yet; Electron does not, because
 * `ipcMain.on` is registered before the renderer process exists (see
 * `desktop/main.ts`, which wires the channel before `loadFile`). An explicit
 * close channel would be redundant with `webContents.on('destroyed')` and
 * would accept a close from any renderer claiming one.
 */
export const ELECTRON_RUNTIME_CHANNEL = 'hanekawa:runtime'

/**
 * Wire the main half: a `RuntimeChannel` that posts to one specific
 * `webContents`.
 *
 * The `target` is supplied by the caller, so a single `ipcMain` can drive
 * several panes — which is why inbound messages are filtered by sender
 * identity rather than trusted wholesale.
 */
export function createElectronMainChannel(
  ipc: MainSideIpc,
  target: MainSideTarget,
): RuntimeChannel {
  const messageHandlers = new Set<(message: unknown) => void>()
  const closeHandlers = new Set<() => void>()
  let closed = false
  let detached = false

  const onIpcMessage: MainIpcListener = (event, message) => {
    // One `ipcMain` serves every pane, so a message from another renderer
    // arrives here too. Drop anything that did not come from our own
    // `webContents`: in real Electron a renderer cannot forge `event.sender`,
    // so identity is the whole check.
    if (event.sender !== target) return
    for (const handler of [...messageHandlers]) handler(message)
  }

  const fireClose = (): void => {
    if (closed) return
    closed = true
    // Detach on *every* close path, not just an explicit `close()`. A destroyed
    // renderer that left its listener on the shared `ipcMain` would leak one
    // per pane for the life of the process.
    detach()
    for (const handler of [...closeHandlers]) handler()
    closeHandlers.clear()
  }

  function detach(): void {
    if (detached) return
    detached = true
    ipc.removeListener(ELECTRON_RUNTIME_CHANNEL, onIpcMessage)
    target.removeListener('destroyed', fireClose)
  }

  ipc.on(ELECTRON_RUNTIME_CHANNEL, onIpcMessage)
  target.on('destroyed', fireClose)

  return {
    post: (message) => {
      if (closed) return
      try {
        target.send(ELECTRON_RUNTIME_CHANNEL, message)
      } catch {
        fireClose()
      }
    },
    onMessage: (handler) => {
      messageHandlers.add(handler)
      return () => {
        messageHandlers.delete(handler)
      }
    },
    onClose: (handler) => {
      if (closed) {
        handler()
        return () => {}
      }
      closeHandlers.add(handler)
      return () => {
        closeHandlers.delete(handler)
      }
    },
    close: () => {
      // Idempotent: `fireClose` guards the notification and `detach` guards the
      // listener removal, so repeated calls are free.
      fireClose()
    },
  }
}
