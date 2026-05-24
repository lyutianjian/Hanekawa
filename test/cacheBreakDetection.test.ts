import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  agentCacheSource,
  checkResponseForCacheBreak,
  formatCacheHitRate,
  notifyCompaction,
  recordPromptState,
  requireCacheSource,
  resetCacheBreakDetection,
} from '../src/harness/cacheBreakDetection.js'

const MAIN_SOURCE = agentCacheSource('main')

test('cache break detection reports system prompt changes', () => {
  resetCacheBreakDetection()

  recordPromptState({ system: 'system a', toolsJson: '[]', model: 'model-a' }, MAIN_SOURCE)
  assert.equal(checkResponseForCacheBreak(50_000, 1_000, MAIN_SOURCE), null)

  recordPromptState({ system: 'system b', toolsJson: '[]', model: 'model-a' }, MAIN_SOURCE)
  const result = checkResponseForCacheBreak(10_000, 1_000, MAIN_SOURCE)

  assert.ok(result)
  assert.ok(result.reasons.some((reason) => reason.startsWith('system_prompt_changed')))
})

test('cache break detection reports tool schema and model changes', () => {
  resetCacheBreakDetection()

  recordPromptState({ system: 'system', toolsJson: '[{"name":"a"}]', model: 'model-a' }, MAIN_SOURCE)
  assert.equal(checkResponseForCacheBreak(50_000, 1_000, MAIN_SOURCE), null)

  recordPromptState({ system: 'system', toolsJson: '[{"name":"b"}]', model: 'model-b' }, MAIN_SOURCE)
  const result = checkResponseForCacheBreak(10_000, 1_000, MAIN_SOURCE)

  assert.ok(result)
  assert.deepEqual(result.reasons, ['tool_schemas_changed', 'model_changed'])
})

test('notifyCompaction resets cache break baseline', () => {
  resetCacheBreakDetection()

  recordPromptState({ system: 'system', toolsJson: '[]', model: 'model-a' }, MAIN_SOURCE)
  assert.equal(checkResponseForCacheBreak(50_000, 1_000, MAIN_SOURCE), null)
  notifyCompaction(MAIN_SOURCE)

  recordPromptState({ system: 'system changed', toolsJson: '[]', model: 'model-a' }, MAIN_SOURCE)
  assert.equal(checkResponseForCacheBreak(10_000, 1_000, MAIN_SOURCE), null)
})


test('resetCacheBreakDetection clears history', () => {
  recordPromptState({ system: 'system', toolsJson: '[]', model: 'model-a' }, MAIN_SOURCE)
  assert.equal(checkResponseForCacheBreak(50_000, 1_000, MAIN_SOURCE), null)

  resetCacheBreakDetection()

  // After reset, a new prompt state with no prior baseline must not trigger a
  // false-positive cache break on the next response.
  recordPromptState({ system: 'system', toolsJson: '[]', model: 'model-a' }, MAIN_SOURCE)
  assert.equal(checkResponseForCacheBreak(10_000, 1_000, MAIN_SOURCE), null)
})

test('formatCacheHitRate shows percentage', () => {
  const result = formatCacheHitRate({ inputTokens: 1000, cacheReadInputTokens: 4000, outputTokens: 500 })
  assert.equal(result, 'cache: 80% hit (4000/5000 tokens)')
})

test('formatCacheHitRate shows n/a for zero tokens', () => {
  const result = formatCacheHitRate({ inputTokens: 0, cacheReadInputTokens: 0, outputTokens: 0 })
  assert.equal(result, 'cache: n/a')
})

test('compact source does not pollute main conversation cache baseline', () => {
  resetCacheBreakDetection()

  // Main conversation establishes a high cache-read baseline.
  recordPromptState({ system: 'main system', toolsJson: '[{"name":"a"}]', model: 'model-a' }, MAIN_SOURCE)
  assert.equal(checkResponseForCacheBreak(50_000, 1_000, MAIN_SOURCE), null)
  recordPromptState({ system: 'main system', toolsJson: '[{"name":"a"}]', model: 'model-a' }, MAIN_SOURCE)
  assert.equal(checkResponseForCacheBreak(50_000, 1_000, MAIN_SOURCE), null)

  // Compaction summarization runs with a totally different system/tools.
  // It must not move the main conversation's prevCacheReadTokens.
  recordPromptState({ system: 'compact system', toolsJson: '[]', model: 'model-a' }, 'compact')
  assert.equal(checkResponseForCacheBreak(0, 1_000, 'compact'), null)
  recordPromptState({ system: 'compact system', toolsJson: '[]', model: 'model-a' }, 'compact')
  // A second compact call would normally look like a cache break, but only
  // for the compact source, never for main.
  checkResponseForCacheBreak(0, 1_000, 'compact')

  // Now the next main turn with the same system should NOT report a break,
  // because the main baseline is still 50_000 — not whatever compact wrote.
  recordPromptState({ system: 'main system', toolsJson: '[{"name":"a"}]', model: 'model-a' }, MAIN_SOURCE)
  const result = checkResponseForCacheBreak(50_000, 1_000, MAIN_SOURCE)
  assert.equal(result, null)
})

test('cache break detection reports beta header and cache scope changes', () => {
  resetCacheBreakDetection()

  recordPromptState({
    system: 'system',
    toolsJson: '[]',
    model: 'model-a',
    betas: [],
    cacheScope: 'ephemeral:5m',
  }, MAIN_SOURCE)
  assert.equal(checkResponseForCacheBreak(50_000, 1_000, MAIN_SOURCE), null)

  recordPromptState({
    system: 'system',
    toolsJson: '[]',
    model: 'model-a',
    betas: ['extended-cache-ttl-2025-04-11'],
    cacheScope: 'ephemeral:1h',
  }, MAIN_SOURCE)
  const result = checkResponseForCacheBreak(10_000, 1_000, MAIN_SOURCE)

  assert.ok(result)
  assert.deepEqual(result.reasons, ['beta_headers_changed', 'cache_scope_changed'])
})

test('debug cache break writes hash-only diagnostics', async () => {
  resetCacheBreakDetection()
  const originalDebug = process.env.MYAGENT_DEBUG_PROVIDER
  const originalCwd = process.cwd()
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-cache-break-'))
  process.env.MYAGENT_DEBUG_PROVIDER = '1'
  process.chdir(dir)
  try {
    recordPromptState({ system: 'system-a', toolsJson: '[]', model: 'model-a' }, MAIN_SOURCE)
    assert.equal(checkResponseForCacheBreak(50_000, 1_000, MAIN_SOURCE), null)
    recordPromptState({ system: 'system-b', toolsJson: '[]', model: 'model-a' }, MAIN_SOURCE)
    assert.ok(checkResponseForCacheBreak(10_000, 1_000, MAIN_SOURCE))

    const diagnosticsDir = path.join(dir, '.myagent', 'diagnostics')
    assert.equal(existsSync(diagnosticsDir), true)
    const files = readdirSync(diagnosticsDir).filter((file) => file.includes('cache-break'))
    assert.equal(files.length, 1)
    const body = readFileSync(path.join(diagnosticsDir, files[0] ?? ''), 'utf-8')
    const diagnostic = JSON.parse(body) as Record<string, unknown>
    assert.equal(diagnostic.event, 'tengu_prompt_cache_break')
    assert.equal(body.includes('system-a'), false)
    assert.equal(body.includes('system-b'), false)
    assert.ok(diagnostic.hashes)
    assert.ok(Array.isArray(diagnostic.hash_diff))
  } finally {
    process.chdir(originalCwd)
    if (originalDebug === undefined) {
      delete process.env.MYAGENT_DEBUG_PROVIDER
    } else {
      process.env.MYAGENT_DEBUG_PROVIDER = originalDebug
    }
    await rm(dir, { recursive: true, force: true })
  }
})

test('agent sources are partitioned by id', () => {
  resetCacheBreakDetection()
  const left = agentCacheSource('left')
  const right = agentCacheSource('right')

  recordPromptState({ system: 'left system', toolsJson: '[]', model: 'm' }, left)
  assert.equal(checkResponseForCacheBreak(30_000, 1_000, left), null)
  recordPromptState({ system: 'right system', toolsJson: '[]', model: 'm' }, right)
  assert.equal(checkResponseForCacheBreak(1_000, 1_000, right), null)

  recordPromptState({ system: 'left system', toolsJson: '[]', model: 'm' }, left)
  assert.equal(checkResponseForCacheBreak(30_000, 1_000, left), null)
})

test('requireCacheSource rejects missing request source', () => {
  assert.throws(() => requireCacheSource(undefined), /cacheSource is required/)
  assert.equal(requireCacheSource(agentCacheSource('s1')), 'agent:s1')
})

test('break in main source does not leak into compact source state', () => {
  resetCacheBreakDetection()

  recordPromptState({ system: 'sys', toolsJson: '[]', model: 'm' }, MAIN_SOURCE)
  assert.equal(checkResponseForCacheBreak(40_000, 1_000, MAIN_SOURCE), null)
  recordPromptState({ system: 'sys-changed', toolsJson: '[]', model: 'm' }, MAIN_SOURCE)
  const mainBreak = checkResponseForCacheBreak(5_000, 1_000, MAIN_SOURCE)
  assert.ok(mainBreak)
  assert.equal(mainBreak.source, MAIN_SOURCE)

  // Compact has never been recorded yet — first call must not trigger a break.
  recordPromptState({ system: 'compact-sys', toolsJson: '[]', model: 'm' }, 'compact')
  assert.equal(checkResponseForCacheBreak(8_000, 1_000, 'compact'), null)
})

test('resetCacheBreakDetection scoped to a single source', () => {
  resetCacheBreakDetection()

  recordPromptState({ system: 'a', toolsJson: '[]', model: 'm' }, MAIN_SOURCE)
  assert.equal(checkResponseForCacheBreak(10_000, 1_000, MAIN_SOURCE), null)
  recordPromptState({ system: 'a', toolsJson: '[]', model: 'm' }, MAIN_SOURCE)

  recordPromptState({ system: 'b', toolsJson: '[]', model: 'm' }, 'compact')
  assert.equal(checkResponseForCacheBreak(20_000, 1_000, 'compact'), null)
  recordPromptState({ system: 'b', toolsJson: '[]', model: 'm' }, 'compact')

  resetCacheBreakDetection('compact')

  // Main baseline survives a compact-only reset.
  recordPromptState({ system: 'a', toolsJson: '[]', model: 'm' }, MAIN_SOURCE)
  // No cache break for main: baseline is still 10_000.
  assert.equal(checkResponseForCacheBreak(10_000, 1_000, MAIN_SOURCE), null)

  // Compact has been wiped, so first call after reset must not fire.
  recordPromptState({ system: 'b', toolsJson: '[]', model: 'm' }, 'compact')
  assert.equal(checkResponseForCacheBreak(1_000, 1_000, 'compact'), null)
})

test('notifyCompaction is scoped to its source', () => {
  resetCacheBreakDetection()

  recordPromptState({ system: 'main', toolsJson: '[]', model: 'm' }, MAIN_SOURCE)
  assert.equal(checkResponseForCacheBreak(40_000, 1_000, MAIN_SOURCE), null)
  recordPromptState({ system: 'compact', toolsJson: '[]', model: 'm' }, 'compact')
  assert.equal(checkResponseForCacheBreak(40_000, 1_000, 'compact'), null)

  notifyCompaction('compact')

  // Main is untouched: a token drop on the next main response should still
  // surface as a break (server_side at minimum).
  recordPromptState({ system: 'main', toolsJson: '[]', model: 'm' }, MAIN_SOURCE)
  const mainResult = checkResponseForCacheBreak(5_000, 1_000, MAIN_SOURCE)
  assert.ok(mainResult)
  assert.equal(mainResult.source, MAIN_SOURCE)

  // Compact baseline was reset — first response after notifyCompaction
  // must not produce a break.
  recordPromptState({ system: 'compact', toolsJson: '[]', model: 'm' }, 'compact')
  assert.equal(checkResponseForCacheBreak(1_000, 1_000, 'compact'), null)
})
