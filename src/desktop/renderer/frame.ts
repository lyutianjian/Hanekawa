/**
 * Frame coalescing for the two repaints a streaming turn drives.
 *
 * A turn posts a `session-event` per streamed chunk and a `snapshot` per chunk
 * beside it, and each one used to run a whole paint: `groupTranscript` over
 * every item, a signature walk over every step, a re-parse of the growing
 * draft's markdown, plus the chip, the status line and the sidebar. That cost is
 * linear in the conversation, so a long session paid it tens of times a second
 * and the window stopped answering.
 *
 * The paints are idempotent functions of pane state, so the fix is to run at
 * most one per frame rather than one per chunk. Nothing here decides *what* is
 * drawn — see `paneSession.ts` for the two call sites.
 *
 * **Leading edge**, deliberately: the first request after an idle beat paints
 * synchronously, so a click, a keystroke or the boot sequence still lands in the
 * same tick and no caller has to learn a new contract. Only a burst — which is
 * to say, only streaming — is deferred, and then by one frame.
 *
 * The scheduler is a parameter so this file can be tested without a fake clock.
 */

/** Schedules `run` for the next frame and hands back the cancel for it. */
export type Scheduler = (run: () => void) => () => void

export interface Repaint {
  /**
   * Paint now if nothing was painted this frame; otherwise mark the pane dirty
   * and paint once at the end of it.
   */
  request(): void
  /** Paint a pending frame immediately. A no-op when nothing is pending. */
  flush(): void
  /** Drop a pending frame without painting it (a pane going to the background). */
  cancel(): void
}

/**
 * A fixed ~30fps beat rather than `requestAnimationFrame`: streamed text reads
 * just as smoothly, and a 120Hz display no longer quadruples the paint work of
 * a turn. `turn-end` flushes, so the last chunk never waits out a beat.
 */
const STREAM_FRAME_MS = 33

const defaultScheduler: Scheduler = (run) => {
  const timer = setTimeout(run, STREAM_FRAME_MS)
  return () => clearTimeout(timer)
}

export function createRepaint(paint: () => void, schedule: Scheduler = defaultScheduler): Repaint {
  /** Set for the length of one frame after a paint; the throttle's window. */
  let closed = false
  /** A request arrived while the window was closed, so the frame owes a paint. */
  let dirty = false
  let cancelScheduled: (() => void) | undefined

  /**
   * Closes the window and opens it again a frame later, painting once more if
   * anything asked in between. The window keeps re-arming while requests keep
   * coming, so a stream that never pauses still paints at exactly the beat.
   */
  function openFrame(): void {
    closed = true
    cancelScheduled = schedule(() => {
      cancelScheduled = undefined
      closed = false
      if (!dirty) return
      dirty = false
      paint()
      openFrame()
    })
  }

  return {
    request(): void {
      if (closed) {
        dirty = true
        return
      }
      paint()
      openFrame()
    },
    flush(): void {
      if (!dirty) return
      dirty = false
      paint()
    },
    cancel(): void {
      dirty = false
      closed = false
      cancelScheduled?.()
      cancelScheduled = undefined
    },
  }
}
