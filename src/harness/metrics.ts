import type { CacheBreakSource } from './cacheBreakDetection.js'

export type SessionMetric =
  | {
      event: 'turn'
      created_at: string
      session_id: string
      model: string
      response_tokens: number
      cache_read_tokens: number
      cache_hit_rate: number | null
      tool_calls: number
      duration_ms: number
    }
  | {
      event: 'compact'
      created_at: string
      session_id: string
      model: string
      pre_tokens: number
      post_tokens: number
      compact_duration_ms: number
    }
  | {
      event: 'cache_break'
      created_at: string
      session_id: string
      source: CacheBreakSource
      reasons: string[]
      drop_tokens: number
    }
  | {
      event: 'mcp_connect_failed'
      created_at: string
      session_id: string
      server: string
      error: string
    }

type MetricInput<T extends SessionMetric> = Omit<T, 'created_at' | 'session_id'>

export type SessionMetricInput =
  | MetricInput<Extract<SessionMetric, { event: 'turn' }>>
  | MetricInput<Extract<SessionMetric, { event: 'compact' }>>
  | MetricInput<Extract<SessionMetric, { event: 'cache_break' }>>
  | MetricInput<Extract<SessionMetric, { event: 'mcp_connect_failed' }>>

export function cacheHitRate(inputTokens: number, cacheReadTokens: number): number | null {
  const total = inputTokens + cacheReadTokens
  if (total === 0) return null
  return cacheReadTokens / total
}
