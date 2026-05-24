/**
 * Unified prompt cache diagnostics.
 *
 * Two responsibilities:
 *
 *  1. Cache-break detection: track prompt state (system, tools, model) before
 *     each request, then compare cache_read_input_tokens after the response to
 *     classify a break by cause (system_prompt_changed, tool_schemas_changed,
 *     model_changed, or server_side eviction).
 *
 *  2. Hit-rate formatting: a small helper for human-readable cache hit rate
 *     output, kept here so all prompt-cache diagnostics live together.
 *
 * State is partitioned by `source` so unrelated request streams do not pollute
 * each other's cache-read baselines. Keep main agent conversations under
 * `agent:<id>`; reserve the other names for non-agent request streams.
 */

export type CacheBreakSource =
  | `agent:${string}`
  | 'repl_main_thread'
  | 'sdk'
  | 'compact'
  | 'hook_agent'
  | 'hook_prompt'
  | 'verification_agent'
  | 'side_question'
  | 'auto_mode'
  | 'bash_classifier'

export function agentCacheSource(agentId: string): CacheBreakSource {
  const normalized = agentId.trim() || 'unknown'
  return `agent:${normalized}`
}

export function requireCacheSource(source: CacheBreakSource | undefined): CacheBreakSource {
  if (!source) {
    throw new Error('ModelRequest.cacheSource is required for prompt cache diagnostics.')
  }
  return source
}

export interface CacheUsageSnapshot {
  inputTokens: number
  cacheReadInputTokens: number
  outputTokens: number
}

interface PreviousSnapshot {
  systemHash: number
  toolsHash: number
  model: string
  systemCharCount: number
  prevCacheReadTokens: number | null
}

interface PendingChanges {
  systemPromptChanged: boolean
  toolSchemasChanged: boolean
  modelChanged: boolean
  systemCharDelta: number
}

interface PromptState {
  system: string
  toolsJson: string
  model: string
}

const previousSnapshots = new Map<CacheBreakSource, PreviousSnapshot>()
const pendingChangesBySource = new Map<CacheBreakSource, PendingChanges>()

export function recordPromptState(
  state: PromptState,
  source: CacheBreakSource,
): void {
  const systemHash = hashString(state.system)
  const toolsHash = hashString(state.toolsJson)

  const changes: PendingChanges = {
    systemPromptChanged: false,
    toolSchemasChanged: false,
    modelChanged: false,
    systemCharDelta: 0,
  }

  const previous = previousSnapshots.get(source)
  if (previous) {
    if (previous.systemHash !== systemHash) {
      changes.systemPromptChanged = true
      changes.systemCharDelta = state.system.length - previous.systemCharCount
    }
    if (previous.toolsHash !== toolsHash) {
      changes.toolSchemasChanged = true
    }
    if (previous.model !== state.model) {
      changes.modelChanged = true
    }
  }

  pendingChangesBySource.set(source, changes)

  previousSnapshots.set(source, {
    systemHash,
    toolsHash,
    model: state.model,
    systemCharCount: state.system.length,
    prevCacheReadTokens: previous?.prevCacheReadTokens ?? null,
  })
}

export function checkResponseForCacheBreak(
  cacheReadTokens: number,
  inputTokens: number,
  source: CacheBreakSource,
): CacheBreakResult | null {
  void inputTokens
  const previous = previousSnapshots.get(source)
  if (!previous) return null

  const prevCacheRead = previous.prevCacheReadTokens
  previous.prevCacheReadTokens = cacheReadTokens

  if (prevCacheRead === null) return null

  const tokenDrop = prevCacheRead - cacheReadTokens
  if (cacheReadTokens >= prevCacheRead * 0.95 || tokenDrop < 2000) {
    pendingChangesBySource.delete(source)
    return null
  }

  const result: CacheBreakResult = {
    tokenDrop,
    prevCacheRead,
    currentCacheRead: cacheReadTokens,
    reasons: [],
    source,
  }

  const pending = pendingChangesBySource.get(source)
  if (pending) {
    if (pending.systemPromptChanged) {
      result.reasons.push(`system_prompt_changed(+${pending.systemCharDelta} chars)`)
    }
    if (pending.toolSchemasChanged) {
      result.reasons.push('tool_schemas_changed')
    }
    if (pending.modelChanged) {
      result.reasons.push('model_changed')
    }
    pendingChangesBySource.delete(source)
  }

  if (result.reasons.length === 0) {
    result.reasons.push('server_side')
  }

  if (process.env.MYAGENT_DEBUG_PROVIDER === '1') {
    console.error(
      `[myagent][cache-break] source=${source} drop=${tokenDrop} tokens prev=${prevCacheRead} current=${cacheReadTokens} reasons=${result.reasons.join(',')}`,
    )
  }

  return result
}

export interface CacheBreakResult {
  tokenDrop: number
  prevCacheRead: number
  currentCacheRead: number
  reasons: string[]
  source: CacheBreakSource
}

export function notifyCompaction(source: CacheBreakSource): void {
  const previous = previousSnapshots.get(source)
  if (previous) {
    previous.prevCacheReadTokens = null
  }
}

export function resetCacheBreakDetection(source?: CacheBreakSource): void {
  if (source === undefined) {
    previousSnapshots.clear()
    pendingChangesBySource.clear()
    return
  }
  previousSnapshots.delete(source)
  pendingChangesBySource.delete(source)
}

/**
 * Format a cache hit-rate summary line for debug output.
 */
export function formatCacheHitRate(usage: CacheUsageSnapshot): string {
  const total = usage.inputTokens + usage.cacheReadInputTokens
  if (total === 0) return 'cache: n/a'
  const hitRate = (usage.cacheReadInputTokens / total) * 100
  return `cache: ${hitRate.toFixed(0)}% hit (${usage.cacheReadInputTokens}/${total} tokens)`
}

function hashString(str: string): number {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i)
    hash = ((hash << 5) - hash + char) | 0
  }
  return hash
}
