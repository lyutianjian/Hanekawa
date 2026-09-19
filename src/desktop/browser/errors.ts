/**
 * The browser subsystem's one error type.
 *
 * It lives apart from `tabs.ts` because everything downstream of the tab host —
 * the snapshot cache, the encoder, the projection — throws these too, and those
 * modules are pure: importing them must not drag Electron into a `node:test`
 * process.
 *
 * Callers branch on `code`, never on a subclass. One code per distinguishable
 * situation, and situations we deliberately refuse to distinguish (an expired
 * snapshot and a forged one) share a code on purpose.
 */
export class BrowserHostError extends Error {
  readonly code: string
  readonly retryable: boolean

  constructor(code: string, message: string, retryable = false) {
    super(message)
    this.code = code
    this.retryable = retryable
  }
}
