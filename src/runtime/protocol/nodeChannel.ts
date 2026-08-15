import type { RuntimeChannel } from './channel.js'

/**
 * The minimum of `child_process`'s IPC surface this transport needs. Typed
 * structurally so both ends work: a parent holds a `ChildProcess`, the child
 * uses `process` itself.
 */
export interface NodeIpcTarget {
  /**
   * Method syntax on purpose: `ChildProcess.send` declares its parameter as
   * `Serializable`, which a property-typed `(message: unknown) => …` would
   * reject. Method parameters are bivariant, so both ends satisfy this.
   */
  send?(message: never): boolean | void
  on(event: 'message', listener: (message: unknown) => void): unknown
  on(event: 'exit' | 'close' | 'disconnect', listener: () => void): unknown
  disconnect?: () => void
}

/**
 * A channel over Node's built-in process IPC.
 *
 * This is the closest thing to Electron's `ipcMain`/`ipcRenderer` that needs no
 * dependency: both serialize with the structured clone algorithm and both
 * deliver asynchronously across a real process boundary. Proving the protocol
 * here means the Electron adapter is a rename.
 *
 * `exit`, `close` and `disconnect` all count as the peer being gone — a crashed
 * renderer must release pending UI requests exactly like a closed one does.
 */
export function createNodeProcessChannel(target: NodeIpcTarget): RuntimeChannel {
  const messageHandlers = new Set<(message: unknown) => void>()
  const closeHandlers = new Set<() => void>()
  let closed = false

  const onIpcMessage = (message: unknown): void => {
    for (const handler of [...messageHandlers]) handler(message)
  }

  const fireClose = (): void => {
    if (closed) return
    closed = true
    for (const handler of [...closeHandlers]) handler()
    closeHandlers.clear()
  }

  target.on('message', onIpcMessage)
  target.on('exit', fireClose)
  target.on('close', fireClose)
  target.on('disconnect', fireClose)

  return {
    post: (message) => {
      if (closed || !target.send) return
      // The peer can vanish between the check and the write; a failed send is
      // just a closed channel, not an error the caller can do anything about.
      try {
        target.send(message as never)
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
      fireClose()
      target.disconnect?.()
    },
  }
}
