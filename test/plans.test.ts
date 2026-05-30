import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  clearAllPlanSlugs,
  clearPlanSlug,
  copyPlanFile,
  generateWordSlug,
  getOrCreatePlanSlug,
  getPlanFilePath,
  getPlanSlug,
  getPlansDir,
  readPlan,
  setPlanSlug,
  writePlan,
} from '../src/utils/plans.js'

async function withTempCwd<T>(fn: (cwd: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hanekawa-plans-'))
  try {
    clearAllPlanSlugs() // ensure isolation across tests
    return await fn(dir)
  } finally {
    clearAllPlanSlugs()
    await rm(dir, { recursive: true, force: true })
  }
}

test('generateWordSlug emits adjective-verb-noun pattern', () => {
  for (let i = 0; i < 20; i++) {
    const slug = generateWordSlug()
    assert.match(slug, /^[a-z]+-[a-z]+-[a-z]+$/)
  }
})

test('getPlansDir creates the directory and returns its absolute path', async () => {
  await withTempCwd(async (cwd) => {
    const dir = getPlansDir(cwd)
    assert.equal(dir, path.join(cwd, '.myagent', 'plans'))
    assert.ok(existsSync(dir))
  })
})

test('getOrCreatePlanSlug is lazy: first call generates, second returns cached', async () => {
  await withTempCwd(async (cwd) => {
    const sessionId = 'sess-aaa'
    assert.equal(getPlanSlug(sessionId), undefined, 'no slug before first call')
    const slug1 = getOrCreatePlanSlug(cwd, sessionId)
    assert.match(slug1, /^[a-z]+-[a-z]+-[a-z]+$/)
    const slug2 = getOrCreatePlanSlug(cwd, sessionId)
    assert.equal(slug2, slug1, 'second call returns cached')
    assert.equal(getPlanSlug(sessionId), slug1, 'getPlanSlug reflects cache')
  })
})

test('setPlanSlug overrides cache for resume scenarios', async () => {
  await withTempCwd(async (cwd) => {
    const sessionId = 'sess-bbb'
    setPlanSlug(sessionId, 'forced-test-slug')
    assert.equal(getPlanSlug(sessionId), 'forced-test-slug')
    assert.equal(getOrCreatePlanSlug(cwd, sessionId), 'forced-test-slug')
  })
})

test('clearPlanSlug invalidates a single session', async () => {
  await withTempCwd(async (cwd) => {
    const sessionA = 'sess-A'
    const sessionB = 'sess-B'
    const slugA = getOrCreatePlanSlug(cwd, sessionA)
    const slugB = getOrCreatePlanSlug(cwd, sessionB)
    clearPlanSlug(sessionA)
    assert.equal(getPlanSlug(sessionA), undefined)
    assert.equal(getPlanSlug(sessionB), slugB, 'sibling unaffected')
    void slugA
  })
})

test('getPlanFilePath returns <plansDir>/<slug>.md for main session', async () => {
  await withTempCwd(async (cwd) => {
    const sessionId = 'sess-main'
    const filePath = getPlanFilePath(cwd, sessionId)
    const slug = getPlanSlug(sessionId)
    assert.ok(slug)
    assert.equal(filePath, path.join(cwd, '.myagent', 'plans', `${slug}.md`))
  })
})

test('getPlanFilePath returns <plansDir>/<slug>-agent-<id>.md for sub-agents', async () => {
  await withTempCwd(async (cwd) => {
    const sessionId = 'sess-with-sub'
    const mainPath = getPlanFilePath(cwd, sessionId)
    const subPath = getPlanFilePath(cwd, sessionId, 'agent-xyz')
    const slug = getPlanSlug(sessionId)
    assert.ok(slug)
    assert.equal(mainPath, path.join(cwd, '.myagent', 'plans', `${slug}.md`))
    assert.equal(subPath, path.join(cwd, '.myagent', 'plans', `${slug}-agent-agent-xyz.md`))
  })
})

test('writePlan + readPlan round-trip', async () => {
  await withTempCwd(async (cwd) => {
    const sessionId = 'sess-rt'
    const filePath = getPlanFilePath(cwd, sessionId)
    await writePlan(filePath, '# My Plan\n\nstep 1\nstep 2\n')
    const content = await readPlan(filePath)
    assert.equal(content, '# My Plan\n\nstep 1\nstep 2\n')
  })
})

test('readPlan returns null on ENOENT', async () => {
  await withTempCwd(async (cwd) => {
    const missing = path.join(cwd, '.myagent', 'plans', 'no-such.md')
    const content = await readPlan(missing)
    assert.equal(content, null)
  })
})

test('writePlan is atomic (temp file + rename); concurrent writers leave consistent file', async () => {
  await withTempCwd(async (cwd) => {
    const sessionId = 'sess-atomic'
    const filePath = getPlanFilePath(cwd, sessionId)
    // Two concurrent writes. On POSIX, both succeed and last-rename wins.
    // On Windows, one of the renames may fail with ENOENT because rename
    // semantics differ — that's acceptable as long as the surviving file
    // contains a complete payload, not an interleaved partial.
    const results = await Promise.allSettled([
      writePlan(filePath, 'A'.repeat(1000)),
      writePlan(filePath, 'B'.repeat(1000)),
    ])
    // At least one must succeed.
    assert.ok(results.some((r) => r.status === 'fulfilled'))
    const content = await readPlan(filePath)
    assert.ok(content, 'file exists after concurrent writes')
    // Either full A's or full B's, never an interleaved partial.
    assert.ok(
      content === 'A'.repeat(1000) || content === 'B'.repeat(1000),
      'content is one of the two complete payloads, not partial',
    )
  })
})

test('copyPlanFile duplicates content to a new path', async () => {
  await withTempCwd(async (cwd) => {
    const sessionA = 'sess-src'
    const sessionB = 'sess-dst'
    const srcPath = getPlanFilePath(cwd, sessionA)
    await writePlan(srcPath, 'parent body')
    const dstPath = getPlanFilePath(cwd, sessionB)
    await copyPlanFile(srcPath, dstPath)
    assert.equal(await readPlan(dstPath), 'parent body')
    // Modifying dst doesn't affect src.
    await writePlan(dstPath, 'child diverged')
    assert.equal(await readPlan(srcPath), 'parent body')
  })
})

test('different sessions get different slugs', async () => {
  await withTempCwd(async (cwd) => {
    const slugA = getOrCreatePlanSlug(cwd, 'sess-X')
    const slugB = getOrCreatePlanSlug(cwd, 'sess-Y')
    assert.notEqual(slugA, slugB)
  })
})
