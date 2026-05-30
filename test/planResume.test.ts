import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PermissionGate } from '../src/harness/permissions.js'
import { PlanModeManager } from '../src/harness/planModeManager.js'
import { SessionStore } from '../src/sessions/service.js'
import {
  clearAllPlanSlugs,
  copyPlanFile,
  getPlanFilePath,
  readPlan,
  writePlan,
} from '../src/utils/plans.js'
import type { SessionRecord } from '../src/harness/types.js'

async function withTempCwd<T>(fn: (cwd: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hanekawa-resume-'))
  try {
    clearAllPlanSlugs()
    return await fn(dir)
  } finally {
    clearAllPlanSlugs()
    await rm(dir, { recursive: true, force: true })
  }
}

function buildManager(cwd: string, meta: any, store: SessionStore) {
  const records: SessionRecord[] = []
  const gate = new PermissionGate(async () => true, undefined, { mode: 'default', cwd })
  const manager = new PlanModeManager({
    cwd,
    sessionMeta: meta,
    store,
    gate,
    appendRecord: async (record) => { records.push(record) },
  })
  gate.setPlanSlugProvider(() => manager.getSlug())
  return { gate, manager, records }
}

test('Resume: onSessionLoaded is a no-op; plan-mode does NOT carry across processes', async () => {
  await withTempCwd(async (cwd) => {
    const store = new SessionStore(cwd)
    await store.init()
    const meta = await store.create()

    // First lifecycle: enter plan mode and write a plan file to disk.
    {
      const { manager } = buildManager(cwd, meta, store)
      await manager.onEnterPlanMode()
      const planPath = manager.resolvePlanFilePathLazy()
      await writePlan(planPath, '# Resumed plan\n')
    }
    clearAllPlanSlugs() // simulate process restart

    // Resume: fresh manager. onSessionLoaded does nothing (slug is in-memory only).
    const store2 = new SessionStore(cwd)
    await store2.init()
    const reloaded = await store2.load(meta.id)
    assert.ok(reloaded)
    const { manager: manager2 } = buildManager(cwd, reloaded, store2)
    await manager2.onSessionLoaded()
    // After resume, plan mode is inactive and slug is undefined — user must
    // re-enter plan mode if desired. This matches Claude Code behavior.
    assert.equal(manager2.isActive(), false)
    assert.equal(manager2.getSlug(), undefined)
  })
})

test('Resume: meta no longer carries plan fields (planSlug/planModeActive removed)', async () => {
  await withTempCwd(async (cwd) => {
    const store = new SessionStore(cwd)
    await store.init()
    const meta = await store.create()
    const { manager } = buildManager(cwd, meta, store)
    await manager.onEnterPlanMode()
    manager.resolvePlanFilePathLazy()

    // Verify SessionMeta does NOT expose plan fields anymore.
    const reloaded = await store.load(meta.id)
    assert.ok(reloaded)
    assert.equal((reloaded as any).planSlug, undefined)
    assert.equal((reloaded as any).planModeActive, undefined)
  })
})

test('Sub-agent inherits parent plan path via bridge live getter', async () => {
  await withTempCwd(async (cwd) => {
    const store = new SessionStore(cwd)
    await store.init()
    const meta = await store.create()
    const { manager } = buildManager(cwd, meta, store)
    await manager.onEnterPlanMode()
    const planPath = manager.resolvePlanFilePathLazy()
    await writePlan(planPath, '# Parent plan body\n')

    const bridge = manager.buildBridge()
    assert.equal(bridge.parentSessionId, meta.id)
    assert.equal(bridge.activePlanFilePath, planPath, 'bridge resolves to parent path')
  })
})

test('Sub-agent path: getPlanFilePath(cwd, sessionId, agentId) yields agent suffix', async () => {
  await withTempCwd(async (cwd) => {
    const sessionId = 'sess-with-sub'
    const mainPath = getPlanFilePath(cwd, sessionId)
    const subPath = getPlanFilePath(cwd, sessionId, 'agent-123')
    // Sub-agent path shares the same slug prefix as main.
    const slugPrefix = path.basename(mainPath, '.md')
    assert.ok(path.basename(subPath).startsWith(slugPrefix))
    assert.match(path.basename(subPath), /-agent-agent-123\.md$/)
  })
})

test('copyPlanFile creates child file with identical content, distinct path', async () => {
  await withTempCwd(async (cwd) => {
    const sessionA = 'sess-src'
    const sessionB = 'sess-dst'
    const srcPath = getPlanFilePath(cwd, sessionA)
    await writePlan(srcPath, 'parent body')
    const dstPath = getPlanFilePath(cwd, sessionB)
    await copyPlanFile(srcPath, dstPath)
    assert.notEqual(srcPath, dstPath)
    assert.equal(await readPlan(dstPath), 'parent body')
  })
})
