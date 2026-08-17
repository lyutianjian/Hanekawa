import type { RuntimeChannel } from '../../runtime/protocol/channel.js'
import type { DesktopBridge } from '../types.js'

/**
 * The renderer half of the transport: a `RuntimeChannel` over the
 * `window.hanekawa` bridge the preload exposes.
 *
 * This is the code the shipped renderer runs, which is the whole point of it
 * living in its own module. It used to be an object literal inline in
 * `app.ts`, while the tests exercised a *different* `ipcRenderer`-shaped
 * factory that nothing in production ever called — so the two Electron API
 * mistakes in `electronChannel.ts` (`ipc.on` treated as an unsubscriber, and a
 * DOM `addEventListener` on a `WebContents`) sat behind a mock that was happy
 * to satisfy them. Test the thing that ships.
 *
 * The renderer cannot use `ipcRenderer` directly: `contextIsolation` means it
 * only ever sees the three `contextBridge` primitives.
 */

/**
 * The slice of the DOM `window` this needs.
 *
 * Declared structurally rather than as `Window` so the tests can drive it from
 * a plain-node process with no DOM.
 */
export interface BridgeWindow {
  addEventListener(event: 'pagehide', listener: () => void): void
  removeEventListener(event: 'pagehide', listener: () => void): void
}

export function createBridgeChannel(
  bridge: DesktopBridge,
  window: BridgeWindow,
): RuntimeChannel {
  const messageHandlers = new Set<(message: unknown) => void>()
  const closeHandlers = new Set<() => void>()
  let closed = false
  let detached = false
  let bridgeClosed = false

  const fireClose = (): void => {
    if (closed) return
    closed = true
    detach()
    for (const handler of [...closeHandlers]) handler()
    closeHandlers.clear()
  }

  function detach(): void {
    if (detached) return
    detached = true
    unsubscribeBridge()
    window.removeEventListener('pagehide', fireClose)
  }

  // Subscribed once for the life of the channel, not once per handler. The
  // inline version this replaced re-subscribed inside `onMessage` while also
  // fanning out to every handler, so N handlers meant N deliveries each;
  // harmless only because `SessionClient` registers exactly one.
  const unsubscribeBridge = bridge.onMessage((message) => {
    for (const handler of [...messageHandlers]) handler(message)
  })

  // The browser fires a real `pagehide` on navigation and on window close.
  // This is the renderer's only honest "we are going away" signal — a
  // preload-dispatched synthetic event cannot reach this world.
  window.addEventListener('pagehide', fireClose)

  return {
    post: (message) => {
      if (closed) return
      bridge.send(message)
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
      fireClose()
      // Telling the preload to stop delivering is the one step a `pagehide`
      // does not need — the page is already going away — so it is guarded
      // separately and, like everything else here, happens at most once.
      if (bridgeClosed) return
      bridgeClosed = true
      bridge.close()
    },
  }
}
