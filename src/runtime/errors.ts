export type RuntimeStartupErrorCode =
  | 'invalid_settings'
  | 'no_default_model'
  | 'unknown_initial_model'
  | 'unknown_fallback_model'
  | 'unknown_compact_model'
  | 'unknown_model'
  | 'provider_creation_failed'

/**
 * Thrown instead of exiting the process, so any host (TUI, desktop shell,
 * tests) decides how to surface a failed startup. The TUI prints `message`
 * and exits with status 1, preserving the previous behavior.
 */
export class RuntimeStartupError extends Error {
  readonly code: RuntimeStartupErrorCode

  constructor(code: RuntimeStartupErrorCode, message: string) {
    super(message)
    this.name = 'RuntimeStartupError'
    this.code = code
  }
}
