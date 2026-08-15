import type { RuntimeChannel } from './channel.js'

/**
 * A pair of channels wired to each other in one process.
 *
 * Every `post` goes through `structuredClone` and lands on a microtask, so a
 * payload that would fail over real IPC fails here too, and ordering matches a
 * true async transport. That is the whole point: an in-memory transport that
 * quietly passed live objects around would let non-serializable payloads reach
 * `test/protocolChildProcess.test.ts` before anyone noticed.
 */
export function createMemoryChannelPair(): [RuntimeChannel, RuntimeChannel] {
  const ends: MemoryEnd[] = [new MemoryEnd(), new MemoryEnd()]
  ends[0]!.peer = ends[1]!
  ends[1]!.peer = ends[0]!
  return [ends[0]!, ends[1]!]
}

class MemoryEnd implements RuntimeChannel {
  peer: MemoryEnd | undefined
  private readonly messageHandlers = new Set<(message: unknown) => void>()
  private readonly closeHandlers = new Set<() => void>()
  private closed = false

  post(message: unknown): void {
    if (this.closed) return
    const cloned = structuredClone(message)
    queueMicrotask(() => {
      this.peer?.deliver(cloned)
    })
  }

  onMessage(handler: (message: unknown) => void): () => void {
    this.messageHandlers.add(handler)
    return () => {
      this.messageHandlers.delete(handler)
    }
  }

  onClose(handler: () => void): () => void {
    this.closeHandlers.add(handler)
    return () => {
      this.closeHandlers.delete(handler)
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.fireClose()
    this.peer?.close()
  }

  private deliver(message: unknown): void {
    if (this.closed) return
    for (const handler of [...this.messageHandlers]) handler(message)
  }

  private fireClose(): void {
    for (const handler of [...this.closeHandlers]) handler()
    this.closeHandlers.clear()
  }
}
