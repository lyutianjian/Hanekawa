/**
 * Configuration for the DoubleTapDetector.
 * windowMs: time window in milliseconds to detect a double-tap.
 * Must be in range [100, 1000], defaults to 300.
 */
export interface DoubleTapConfig {
  windowMs: number
}

/** Result of a tap operation */
export type TapResult = 'single' | 'double' | 'pending'

const DEFAULT_WINDOW_MS = 300
const MIN_WINDOW_MS = 100
const MAX_WINDOW_MS = 1000

/**
 * Detects double-tap key presses within a configurable time window.
 *
 * On first tap, returns 'pending' and starts a timer. If a second tap of the
 * same key arrives within the window, returns 'double' immediately. If the
 * window expires without a second tap, the onSingle callback is invoked.
 */
export class DoubleTapDetector {
  private lastTapTime: number = 0
  private lastKey: string = ''
  private pendingTimer: ReturnType<typeof setTimeout> | null = null
  private readonly windowMs: number

  constructor(config?: Partial<DoubleTapConfig>) {
    const raw = config?.windowMs ?? DEFAULT_WINDOW_MS
    this.windowMs = validateWindowMs(raw)
  }

  /**
   * Record a key press.
   * @param key - The key that was pressed
   * @param onSingle - Callback invoked after the window expires without a second tap
   * @returns 'double' if this is the second tap within the window, 'pending' on first tap
   */
  tap(key: string, onSingle: () => void): TapResult {
    const now = Date.now()
    const elapsed = now - this.lastTapTime

    // Check for double-tap: same key pressed within the window
    if (this.lastKey === key && elapsed < this.windowMs && this.pendingTimer !== null) {
      // Double-tap detected — cancel the pending single-tap timer
      this.clearPendingTimer()
      this.lastTapTime = 0
      this.lastKey = ''
      return 'double'
    }

    // First tap (or different key / expired window)
    this.clearPendingTimer()
    this.lastTapTime = now
    this.lastKey = key

    // Schedule the single-tap callback after the window expires
    this.pendingTimer = setTimeout(() => {
      this.pendingTimer = null
      this.lastTapTime = 0
      this.lastKey = ''
      onSingle()
    }, this.windowMs)

    return 'pending'
  }

  /** Cancel any pending single-tap timer without invoking the callback */
  cancel(): void {
    this.clearPendingTimer()
    this.lastTapTime = 0
    this.lastKey = ''
  }

  /** Clean up all resources (timers) */
  dispose(): void {
    this.clearPendingTimer()
  }

  private clearPendingTimer(): void {
    if (this.pendingTimer !== null) {
      clearTimeout(this.pendingTimer)
      this.pendingTimer = null
    }
  }
}

/** Validate and clamp the windowMs value to the allowed range */
function validateWindowMs(value: number): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value < MIN_WINDOW_MS ||
    value > MAX_WINDOW_MS
  ) {
    return DEFAULT_WINDOW_MS
  }
  return value
}
