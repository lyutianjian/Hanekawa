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

import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { getMyAgentDir } from '../utils/paths.js'

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
  systemHash: string
  toolsHash: string
  betasHash: string
  cacheScopeHash: string
  model: string
  systemCharCount: number
  prevCacheReadTokens: number | null
}

interface PendingChanges {
  systemPromptChanged: boolean
  toolSchemasChanged: boolean
  betaHeadersChanged: boolean
  cacheScopeChanged: boolean
  modelChanged: boolean
  systemCharDelta: number
  previous: PromptHashes | null
  current: PromptHashes
}

interface PromptState {
  system: string
  toolsJson: string
  model: string
  betas?: string[]
  cacheScope?: string
}

export interface PromptHashes {
  systemHash: string
  toolsHash: string
  betasHash: string
  cacheScopeHash: string
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
  const normalizedBetas = [...(state.betas ?? [])].sort()
  const betasHash = hashString(JSON.stringify(normalizedBetas))
  const cacheScope = state.cacheScope ?? 'default'
  const cacheScopeHash = hashString(cacheScope)
  const current: PromptHashes = {
    systemHash,
    toolsHash,
    betasHash,
    cacheScopeHash,
    model: state.model,
  }

  const changes: PendingChanges = {
    systemPromptChanged: false,
    toolSchemasChanged: false,
    betaHeadersChanged: false,
    cacheScopeChanged: false,
    modelChanged: false,
    systemCharDelta: 0,
    previous: null,
    current,
  }

  const previous = previousSnapshots.get(source)
  if (previous) {
    changes.previous = {
      systemHash: previous.systemHash,
      toolsHash: previous.toolsHash,
      betasHash: previous.betasHash,
      cacheScopeHash: previous.cacheScopeHash,
      model: previous.model,
    }
    if (previous.systemHash !== systemHash) {
      changes.systemPromptChanged = true
      changes.systemCharDelta = state.system.length - previous.systemCharCount
    }
    if (previous.toolsHash !== toolsHash) {
      changes.toolSchemasChanged = true
    }
    if (previous.betasHash !== betasHash) {
      changes.betaHeadersChanged = true
    }
    if (previous.cacheScopeHash !== cacheScopeHash) {
      changes.cacheScopeChanged = true
    }
    if (previous.model !== state.model) {
      changes.modelChanged = true
    }
  }

  pendingChangesBySource.set(source, changes)

  previousSnapshots.set(source, {
    systemHash,
    toolsHash,
    betasHash,
    cacheScopeHash,
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
    if (pending.betaHeadersChanged) {
      result.reasons.push('beta_headers_changed')
    }
    if (pending.cacheScopeChanged) {
      result.reasons.push('cache_scope_changed')
    }
    if (pending.modelChanged) {
      result.reasons.push('model_changed')
    }
    if (pending.previous) {
      result.hashes = {
        previous: pending.previous,
        current: pending.current,
      }
    }
    pendingChangesBySource.delete(source)
  }

  if (result.reasons.length === 0) {
    result.reasons.push('server_side')
  }

  if (process.env.MYAGENT_DEBUG_PROVIDER === '1') {
    const diagnosticsPath = writeCacheBreakDiagnostic(result)
    console.error(
      `[myagent][cache-break] source=${source} drop=${tokenDrop} tokens prev=${prevCacheRead} current=${cacheReadTokens} reasons=${result.reasons.join(',')}${diagnosticsPath ? ` diagnostics=${diagnosticsPath}` : ''}`,
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
  hashes?: {
    previous: PromptHashes
    current: PromptHashes
  }
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

function writeCacheBreakDiagnostic(result: CacheBreakResult): string | null {
  if (!result.hashes) return null
  try {
    const session = result.source.startsWith('agent:') ? result.source.slice('agent:'.length) : result.source
    const diagnosticsDir = path.join(getMyAgentDir(process.cwd()), 'diagnostics')
    mkdirSync(diagnosticsDir, { recursive: true, mode: 0o700 })
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
    const filePath = path.join(diagnosticsDir, `${sanitizeFilePart(session)}-cache-break-${timestamp}.json`)
    const payload = {
      created_at: new Date().toISOString(),
      event: 'tengu_prompt_cache_break',
      source: result.source,
      reasons: result.reasons,
      drop_tokens: result.tokenDrop,
      prev_cache_read_tokens: result.prevCacheRead,
      current_cache_read_tokens: result.currentCacheRead,
      hashes: result.hashes,
      hash_diff: promptHashDiff(result.hashes.previous, result.hashes.current),
    }
    writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 })
    return filePath
  } catch {
    return null
  }
}

function promptHashDiff(previous: PromptHashes, current: PromptHashes): string[] {
  const lines = ['--- previous', '+++ current']
  for (const key of ['systemHash', 'toolsHash', 'betasHash', 'cacheScopeHash', 'model'] as const) {
    if (previous[key] === current[key]) continue
    lines.push(`-${key}: ${previous[key]}`)
    lines.push(`+${key}: ${current[key]}`)
  }
  return lines
}

function sanitizeFilePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80) || 'unknown'
}

function hashString(str: string): string {
  return createHash('sha256').update(str).digest('hex').slice(0, 16)
}
