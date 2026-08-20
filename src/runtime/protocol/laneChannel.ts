import type { RuntimeChannel } from './channel.js'

/**
 * Lane multiplexing over a single `RuntimeChannel`.
 *
 * The desktop shell used to give every pane its own `BrowserWindow`, so a
 * process-wide `ipcMain` could tell panes apart by `event.sender` identity
 * (`electronChannel.ts`). A single window puts every pane behind the same
 * `webContents` and that signal is gone. Rather than threading a `paneId`
 * through all 36 `HostCommand` variants — which would pollute a wire the TUI
 * and `protocolChildProcess` also speak — every message rides this transport
 * inside an envelope naming its lane.
 *
 * Both ends run the same code: the main-process mux and the renderer mux are
 * peers, each handing out `RuntimeChannel` views for lane keys either side
 * created. Nothing here knows about Electron; a memory pair exercises all of
 * it (`test/laneChannel.test.ts`).
 *
 * Three rules the shell depends on:
 *
 * 1. **A lane-level close is a control frame, not a transport close.** Closing
 *    one lane must fire `onClose` on the peer's view of that lane — the hook
 *    that releases every request still pending on it. `SessionHost.dispose()`
 *    does not close the channel, so without the frame a detached pane leaves
 *    the renderer's commands pointed at a host that no longer exists and its
 *    pending requests hang for the life of the process.
 * 2. **Inbound frames for an unattached lane are buffered, bounded.** The main
 *    side builds a lane and its `SessionHost` before `loadFile` resolves, so a
 *    lane's first frames routinely arrive before the renderer calls
 *    `lane(key)`. Losing even one `reply` would hang its matching pending
 *    request forever, so the buffer drains in order on the first attach — and
 *    when it overflows the lane closes rather than dropping frames piecemeal.
 * 3. **A lane key never moves.** Session ids travel under `/clear` and
 *    `/resume`; the lane key is the stable handle for shell bookkeeping.
 */

/** Overflow policy: past this many buffered frames the lane closes outright. */
export const LANE_UNATTACHED_BUFFER_LIMIT = 256

export type LaneFrame =
  | { kind: 'data'; lane: string; body: unknown }
  | { kind: 'close'; lane: string }

export interface LaneMux {
  /** Idempotent while open; the same key after `closeLane` yields a closed view. */
  lane(key: string): RuntimeChannel
  /** Retires one lane on both sides. Idempotent; unknown keys become tombstones. */
  closeLane(key: string): void
  /** Retires every lane, then the transport. The peer sees one transport death. */
  close(): void
}

interface LaneState {
  closed: boolean
  messageHandlers: Set<(message: unknown) => void>
  closeHandlers: Set<() => void>
  /** Inbound bodies waiting for the first (or the next) drain. */
  buffer: unknown[]
  drainScheduled: boolean
  /** The stable `RuntimeChannel` view; one per key for the mux's lifetime. */
  view: RuntimeChannel
}

export function createLaneMux(transport: RuntimeChannel): LaneMux {
  const lanes = new Map<string, LaneState>()
  let dead = false

  function ensureLane(key: string): LaneState {
    const existing = lanes.get(key)
    if (existing) return existing
    const state: LaneState = {
      // A lane minted after the transport died is born closed: `lane()` on a
      // dead mux must hand back a dead view, not a fresh one that buffers
      // forever.
      closed: dead,
      messageHandlers: new Set(),
      closeHandlers: new Set(),
      buffer: [],
      drainScheduled: false,
      view: undefined as never,
    }
    state.view = makeView(key)
    lanes.set(key, state)
    return state
  }

  function closeState(key: string, state: LaneState): void {
    state.closed = true
    state.buffer = []
    state.drainScheduled = false
    fireClose(state)
    if (!dead) transport.post({ kind: 'close', lane: key })
  }

  function closeRemote(state: LaneState): void {
    // The peer closed the lane; no echo, or two politely closing sides would
    // ping-pong forever.
    if (state.closed) return
    state.closed = true
    state.buffer = []
    state.drainScheduled = false
    fireClose(state)
  }

  function fireClose(state: LaneState): void {
    const handlers = [...state.closeHandlers]
    state.closeHandlers.clear()
    for (const handler of handlers) handler()
  }

  function deliver(state: LaneState, body: unknown): void {
    for (const handler of [...state.messageHandlers]) handler(body)
  }

  function scheduleDrain(state: LaneState): void {
    if (state.drainScheduled || state.closed) return
    state.drainScheduled = true
    queueMicrotask(() => {
      state.drainScheduled = false
      if (state.closed) return
      while (state.buffer.length > 0 && state.messageHandlers.size > 0) {
        const body = state.buffer.shift()
        deliver(state, body)
      }
    })
  }

  function receive(frame: unknown): void {
    if (dead || !isLaneFrame(frame)) return
    if (frame.kind === 'close') {
      closeRemote(ensureLane(frame.lane))
      return
    }
    const state = ensureLane(frame.lane)
    if (state.closed) return
    // Buffer while nobody is attached, and keep buffering while a drain is
    // pending so a frame that overtakes the drain cannot jump the queue.
    if (state.messageHandlers.size === 0 || state.buffer.length > 0) {
      state.buffer.push(frame.body)
      if (state.buffer.length > LANE_UNATTACHED_BUFFER_LIMIT) {
        // Dropping a single frame would strand whichever request it answered;
        // closing is the failure `PendingRequests` already knows how to absorb.
        closeState(frame.lane, state)
        return
      }
      if (state.messageHandlers.size > 0) scheduleDrain(state)
      return
    }
    deliver(state, frame.body)
  }

  transport.onMessage(receive)
  transport.onClose(() => {
    if (dead) return
    dead = true
    for (const state of lanes.values()) closeRemote(state)
  })

  function makeView(key: string): RuntimeChannel {
    return {
      post: (message) => {
        if (dead) return
        const state = lanes.get(key)
        if (!state || state.closed) return
        // No try/catch on purpose: the transport owns clone semantics, and
        // swallowing a non-cloneable body here would hide a wire violation the
        // memory pair exists to catch.
        transport.post({ kind: 'data', lane: key, body: message })
      },
      onMessage: (handler) => {
        const state = ensureLane(key)
        state.messageHandlers.add(handler)
        if (state.buffer.length > 0) scheduleDrain(state)
        return () => {
          state.messageHandlers.delete(handler)
        }
      },
      onClose: (handler) => {
        const state = ensureLane(key)
        // Registering on a closed lane fires immediately, mirroring
        // `createElectronMainChannel`: a late subscriber must learn the lane
        // is gone, not wait for a close that already happened.
        if (state.closed || dead) {
          handler()
          return () => {}
        }
        state.closeHandlers.add(handler)
        return () => {
          state.closeHandlers.delete(handler)
        }
      },
      close: () => {
        closeLane(key)
      },
    }
  }

  function closeLane(key: string): void {
    const state = ensureLane(key)
    if (state.closed) return
    closeState(key, state)
  }

  function close(): void {
    // Per-lane close frames are deliberately not sent: the transport close is
    // itself the per-lane signal on the peer (its mux fires every lane's
    // `onClose`), and frames posted here would race the teardown that follows.
    if (!dead) {
      dead = true
      for (const state of lanes.values()) closeRemote(state)
    }
    transport.close()
  }

  return { lane: (key) => ensureLane(key).view, closeLane, close }
}

function isLaneFrame(frame: unknown): frame is LaneFrame {
  if (typeof frame !== 'object' || frame === null) return false
  const record = frame as { kind?: unknown; lane?: unknown }
  if (record.kind !== 'data' && record.kind !== 'close') return false
  return typeof record.lane === 'string'
}
