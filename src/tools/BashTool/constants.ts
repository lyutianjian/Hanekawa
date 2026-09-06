/**
 * Values the `Bash` tool enforces and its description quotes.
 *
 * They live apart from `bash.ts` so `bashPrompt.ts` can read them without
 * importing the tool module that imports the prompt back.
 */

/** Align with Claude Code defaults (2 min / 10 min). */
export const DEFAULT_BASH_TIMEOUT_MS = 120_000
export const MAX_BASH_TIMEOUT_MS = 600_000

/**
 * Minimum sleep duration (seconds) that triggers the blocked-sleep pattern.
 * Sleep commands below this threshold are allowed without run_in_background.
 */
export const SLEEP_BLOCK_THRESHOLD_SECONDS = 2

function parsePositiveInt(value: string | undefined): number | undefined {
  if (!value) return undefined
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

/**
 * Resolve the effective foreground timeout.
 * - explicit tool input wins (clamped to max)
 * - else MYAGENT_BASH_DEFAULT_TIMEOUT_MS / BASH_DEFAULT_TIMEOUT_MS
 * - else 120s
 * Max from MYAGENT_BASH_MAX_TIMEOUT_MS / BASH_MAX_TIMEOUT_MS (at least default), capped schema max 600s.
 */
export function resolveBashTimeoutMs(requested?: number, env: NodeJS.ProcessEnv = process.env): number {
  const envDefault =
    parsePositiveInt(env.MYAGENT_BASH_DEFAULT_TIMEOUT_MS)
    ?? parsePositiveInt(env.BASH_DEFAULT_TIMEOUT_MS)
  const envMax =
    parsePositiveInt(env.MYAGENT_BASH_MAX_TIMEOUT_MS)
    ?? parsePositiveInt(env.BASH_MAX_TIMEOUT_MS)

  const defaultMs = envDefault ?? DEFAULT_BASH_TIMEOUT_MS
  const maxMs = Math.min(
    MAX_BASH_TIMEOUT_MS,
    Math.max(defaultMs, envMax ?? MAX_BASH_TIMEOUT_MS),
  )
  const raw = requested ?? defaultMs
  return Math.min(Math.max(1, raw), maxMs)
}
