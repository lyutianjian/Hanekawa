import type { CacheBreakSource } from './cacheBreakDetection.js'

export type SessionMetric =
  | {
      event: 'turn'
      created_at: string
      session_id: string
      model: string
      input_tokens?: number
      /**
       * Cache writes. Optional because sessions recorded before the split (and
       * endpoints that do not report writes) have none; a reader that needs the
       * prompt total must add it in as 0 rather than assume it was folded into
       * `input_tokens`.
       */
      cache_creation_tokens?: number
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
      event: 'session_cache_summary'
      created_at: string
      session_id: string
      total_cache_hit_rate: number | null
      total_turns: number
      first_break_turn_count: number | null
      cache_break_count: number
      cause_distribution: Record<string, number>
    }
  | {
      event: 'mcp_connect_failed'
      created_at: string
      session_id: string
      server: string
      error: string
    }
  | {
      event: 'permission_denial_state'
      created_at: string
      session_id: string
      total_auto_denials: number
      active_streaks: number
      max_streak: number
      streaks: Record<string, number>
    }

type MetricInput<T extends SessionMetric> = Omit<T, 'created_at' | 'session_id'>

export type SessionMetricInput =
  | MetricInput<Extract<SessionMetric, { event: 'turn' }>>
  | MetricInput<Extract<SessionMetric, { event: 'compact' }>>
  | MetricInput<Extract<SessionMetric, { event: 'cache_break' }>>
  | MetricInput<Extract<SessionMetric, { event: 'session_cache_summary' }>>
  | MetricInput<Extract<SessionMetric, { event: 'mcp_connect_failed' }>>
  | MetricInput<Extract<SessionMetric, { event: 'permission_denial_state' }>>

// The hit rate itself lives in `usage.ts`, beside `promptTokens()`: it is a
// function of a `TokenUsage`, not of two loose numbers, and the denominator has
// to include cache writes — which a caller passing `(inputTokens, readTokens)`
// cannot supply.
