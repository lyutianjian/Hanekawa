/**
 * The transport seam.
 *
 * Everything the protocol needs from the outside world is a duplex pipe that
 * moves structured-cloneable values and tells us when it dies. Electron's
 * `ipcMain`/`ipcRenderer`, a `child_process` fork, a `MessagePort` and an
 * in-memory pair all satisfy this; none of them are imported here.
 */
export interface RuntimeChannel {
  /** Send one message. Must not throw once the channel is closed — drop instead. */
  post(message: unknown): void
  /** Returns an unsubscribe function. */
  onMessage(handler: (message: unknown) => void): () => void
  /**
   * Fires once, when the peer is gone for good. This is what releases every
   * request still waiting on the other side, so it must fire on crashes and
   * window closes, not only on graceful shutdown.
   */
  onClose(handler: () => void): () => void
  close(): void
}
