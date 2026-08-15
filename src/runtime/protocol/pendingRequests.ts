/**
 * Promises waiting on an answer from somewhere that might never send one.
 *
 * Both directions of the protocol need this: the host parks UI questions until
 * a renderer answers, and the client parks command replies until the host does.
 * The shared requirement is `settleAll` — when the channel dies, everything
 * still waiting has to resolve, or the agent loop blocks forever.
 */
export class PendingRequests<T> {
  private readonly resolvers = new Map<string, (value: T) => void>()

  /** Registers `id` and returns the promise its answer will settle. */
  create(id: string): Promise<T> {
    return new Promise<T>((resolve) => {
      this.resolvers.set(id, resolve)
    })
  }

  /** Settles one request. Returns false if `id` was unknown or already settled. */
  settle(id: string, value: T): boolean {
    const resolve = this.resolvers.get(id)
    if (!resolve) return false
    this.resolvers.delete(id)
    resolve(value)
    return true
  }

  /**
   * Settles everything outstanding, newest last. `value` is a factory so each
   * caller gets its own object rather than a shared one.
   */
  settleAll(value: () => T): void {
    // Snapshotted first: a resolver's continuation may register a new request.
    const waiting = [...this.resolvers.values()]
    this.resolvers.clear()
    for (const resolve of waiting) resolve(value())
  }

  get size(): number {
    return this.resolvers.size
  }
}
