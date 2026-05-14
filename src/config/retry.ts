export interface RetryOptions {
  maxRetries?: number
  baseDelayMs?: number
  maxDelayMs?: number
  jitterFactor?: number
  signal?: AbortSignal
  shouldRetry?: (error: unknown, attempt: number) => boolean
}

export async function withRetry<T>(
  operation: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const maxRetries = options.maxRetries ?? 3
  const baseDelayMs = options.baseDelayMs ?? 500
  const maxDelayMs = options.maxDelayMs ?? 32_000
  const jitterFactor = options.jitterFactor ?? 0.25

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    if (options.signal?.aborted) {
      const err = new Error('Request aborted')
      ;(err as Error & { aborted: boolean }).aborted = true
      throw err
    }

    try {
      return await operation(attempt)
    } catch (error) {
      if (attempt > maxRetries) throw error
      if (options.shouldRetry && !options.shouldRetry(error, attempt)) throw error

      const delay = calculateDelay(attempt, baseDelayMs, maxDelayMs, jitterFactor)
      await sleep(delay)
    }
  }

  throw new Error('Unreachable')
}

export function calculateDelay(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
  jitterFactor: number = 0.25,
): number {
  const exponentialDelay = Math.min(baseDelayMs * Math.pow(2, attempt - 1), maxDelayMs)
  const jitter = exponentialDelay * jitterFactor * Math.random()
  return exponentialDelay + jitter
}

export function isRetryableError(error: unknown): boolean {
  if (error instanceof Error) {
    if ((error as Error & { status?: number }).status === 429) return true
    if ((error as Error & { status?: number }).status === 529) return true
    const status = (error as Error & { status?: number }).status
    if (status !== undefined && status >= 500 && status < 600) return true
    const msg = error.message.toLowerCase()
    if (msg.includes('rate') || msg.includes('429')) return true
    if (msg.includes('529') || msg.includes('overload')) return true
    if (msg.includes('timeout')) return true
    if (msg.includes('econnreset') || msg.includes('econnrefused')) return true
  }
  return false
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
