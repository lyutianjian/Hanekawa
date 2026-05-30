import type { Endpoint } from './routing.js'

export interface EndpointPingResult {
  ok: boolean
  /** HTTP status code if a response was received, else undefined. */
  status?: number
  /** Round-trip time in milliseconds. */
  durationMs: number
  /** Short human-readable message; never includes the apiKey. */
  message: string
}

const PING_TIMEOUT_MS = 5_000

/**
 * Reachability probe for an endpoint. This is intentionally a low-effort
 * check: we only verify the baseUrl resolves and accepts a TCP connection.
 *
 * Two probes are tried in order, with the first one that returns any HTTP
 * response treated as a success:
 *   1. GET <baseUrl>/models       -- common to OpenAI-compatible servers
 *   2. GET <baseUrl>              -- bare reachability check
 *
 * Any HTTP status counts as "reachable" (even 404 / 401), since the goal is
 * to distinguish "server up but auth/path may be wrong" from "DNS or network
 * down". Network errors return ok=false.
 *
 * The apiKey is sent as Bearer to give the user a chance to see auth errors
 * but never appears in the result message.
 */
export async function pingEndpoint(endpoint: Endpoint): Promise<EndpointPingResult> {
  const start = Date.now()
  if (!endpoint.baseUrl) {
    return {
      ok: false,
      durationMs: 0,
      message: 'No baseUrl configured',
    }
  }

  let baseUrl: URL
  try {
    baseUrl = new URL(endpoint.baseUrl)
  } catch {
    return {
      ok: false,
      durationMs: 0,
      message: `Invalid baseUrl: ${endpoint.baseUrl}`,
    }
  }

  const trimmedPath = baseUrl.pathname.replace(/\/$/, '')
  const candidates = [
    new URL(`${trimmedPath}/models`, baseUrl).toString(),
    baseUrl.toString(),
  ]

  let lastError: Error | undefined
  for (const url of candidates) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), PING_TIMEOUT_MS)
    try {
      const headers: Record<string, string> = { Accept: 'application/json' }
      if (endpoint.apiKey) {
        headers.Authorization = `Bearer ${endpoint.apiKey}`
        // Anthropic also uses x-api-key. Sending both is safe: servers ignore
        // headers they don't recognize, and we don't reveal the key in logs.
        headers['x-api-key'] = endpoint.apiKey
        headers['anthropic-version'] = '2023-06-01'
      }
      const response = await fetch(url, { method: 'GET', headers, signal: controller.signal })
      const durationMs = Date.now() - start
      const message = describeStatus(response.status)
      return {
        ok: true,
        status: response.status,
        durationMs,
        message,
      }
    } catch (error) {
      lastError = error as Error
      // AbortError -> probably a slow server; try next candidate too.
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    ok: false,
    durationMs: Date.now() - start,
    message: formatError(lastError),
  }
}

function describeStatus(status: number): string {
  if (status >= 200 && status < 300) return `reachable (HTTP ${status})`
  if (status === 401 || status === 403) return `reachable, auth rejected (HTTP ${status})`
  if (status === 404) return `reachable, /models not found (HTTP ${status})`
  if (status >= 500) return `server error (HTTP ${status})`
  return `HTTP ${status}`
}

function formatError(error: Error | undefined): string {
  if (!error) return 'Unknown error'
  if (error.name === 'AbortError') return `Timeout after ${PING_TIMEOUT_MS}ms`
  // node fetch throws TypeError with `cause` on DNS / connection failures.
  const cause = (error as { cause?: { code?: string; message?: string } }).cause
  if (cause?.code) {
    switch (cause.code) {
      case 'ENOTFOUND':
        return 'DNS lookup failed'
      case 'ECONNREFUSED':
        return 'Connection refused'
      case 'ECONNRESET':
        return 'Connection reset'
      case 'ETIMEDOUT':
        return 'Connection timed out'
      default:
        return cause.code
    }
  }
  return error.message || error.name || 'Network error'
}
