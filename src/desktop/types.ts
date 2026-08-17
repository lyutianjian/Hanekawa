/**
 * The single API the renderer sees.
 *
 * Kept intentionally narrow: only `HostCommand` and `HostEvent` cross the
 * boundary, and the renderer never sees a `Tool`, a `ModelProvider`, or an
 * `AbortSignal`. Anything more would have to be cloned on every post, and
 * would leak the host's internal shape into the renderer bundle.
 *
 * `send` accepts `unknown` rather than `HostCommand` because the renderer
 * builds a JSON-style envelope at the call site (the protocol's
 * `zod/v3` validator runs host-side, not here), and a hand-built command
 * shape would mean two type definitions in the renderer bundle for the same
 * thing. The receiving `parseHostCommand` is the source of truth on shapes.
 */
export interface DesktopBridge {
  /** Send a host command. The host validates and replies asynchronously. */
  send(message: unknown): void
  /**
   * Subscribe to host events. Returns an unsubscribe function so the renderer
   * can tear down on reload without leaving handlers dangling on the main side.
   */
  onMessage(handler: (event: unknown) => void): () => void
  /** Renderer side is going away: closest analog to `channel.close()`. */
  close(): void
}

declare global {
  // eslint-disable-next-line @typescript-eslint/consistent-type-definitions, @typescript-eslint/no-empty-object-type
  interface Window {
    /** Populated by the preload via `contextBridge.exposeInMainWorld`. */
    hanekawa?: DesktopBridge
  }
}
