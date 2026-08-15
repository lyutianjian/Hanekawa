import { randomUUID } from 'node:crypto'
import type { SessionRecord } from '../harness/types.js'
import type { BackgroundTaskRegistry } from '../services/backgroundTasks/registry.js'
import type { SessionMeta } from '../sessions/service.js'
import type { RuntimeSlot } from './runtimeSlot.js'
import type { SessionController } from './sessionController.js'
import { buildStartupNotices, type StartupNotice } from './startupNotices.js'
import type { RuntimeHost } from './types.js'

/**
 * Switching the session a runtime is bound to.
 *
 * Retargeting the controller is only half of it: the `AgentLoop` is built
 * around a session and its records, so a switch that skips `createRuntime` +
 * `RuntimeSlot.replace` leaves the loop writing into the session it just left.
 * Background tasks have to be reattached too, and agents that died with a
 * previous process have to be reconciled, or the transcript shows them running
 * forever.
 */
export interface SessionSwitchDeps {
  host: RuntimeHost
  runtimeSlot: RuntimeSlot
  controller: SessionController
  backgroundTasks: BackgroundTaskRegistry
}

export interface SessionSwitchResult {
  session: SessionMeta
  records: SessionRecord[]
  notices: StartupNotice[]
}

export async function switchToExistingSession(
  deps: SessionSwitchDeps,
  sessionId: string,
): Promise<SessionSwitchResult> {
  const meta = await deps.host.store.resolve(sessionId)
  if (!meta) throw new Error(`Unknown session: ${sessionId}`)

  const loaded = await deps.host.store.loadRecordsWithDiagnostics(meta.id)
  const records = [...loaded.records]

  // Already-registered tasks mean this session is live in-process; restoring it
  // again would double-register every one of them.
  const alreadyRegistered = deps.backgroundTasks.getSnapshot(meta.id).length > 0
  const orphanedAgentIds = alreadyRegistered
    ? []
    : await deps.backgroundTasks.restoreSession(meta.id, records)

  for (const record of reconcileOrphanedAgents(records, orphanedAgentIds)) {
    await deps.host.store.appendRecord(meta.id, record)
    records.push(record)
  }

  applySwitch(deps, meta, records)

  return {
    session: meta,
    records,
    notices: buildStartupNotices({ diagnostics: loaded.diagnostics, mcp: deps.host.mcp }),
  }
}

export async function switchToNewSession(
  deps: SessionSwitchDeps,
  options: { previousSessionId: string; title?: string },
): Promise<SessionSwitchResult> {
  deps.runtimeSlot.current.loop.clearCachedSections()
  await deps.backgroundTasks.stopAll(options.previousSessionId, 'Session cleared')
  deps.host.store.discardDraft(options.previousSessionId)

  const meta = options.title
    ? deps.host.store.createDraft(options.title)
    : deps.host.store.createDraft()

  applySwitch(deps, meta, [])

  return { session: meta, records: [], notices: [] }
}

function applySwitch(deps: SessionSwitchDeps, meta: SessionMeta, records: SessionRecord[]): void {
  const next = deps.host.createRuntime(deps.runtimeSlot.current.modelKey, meta, records)
  deps.controller.retarget(meta, records)
  // Last, and never an assignment: replace installs the new runtime before
  // disposing the old one, so a late dispose cannot tear down its successor.
  deps.runtimeSlot.replace(next)
}

/**
 * Synthesizes `subagent_task` interruption records for agents that were still
 * marked running but did not survive into this process.
 *
 * Pure so the policy can be tested without a store: the caller persists and
 * appends whatever comes back.
 */
export function reconcileOrphanedAgents(
  records: readonly SessionRecord[],
  orphanedAgentIds: Iterable<string>,
  now: () => string = () => new Date().toISOString(),
  createId: () => string = randomUUID,
): SessionRecord[] {
  const orphaned = [...orphanedAgentIds]
  if (orphaned.length === 0) return []

  const latestTasks = new Map<string, Extract<SessionRecord, { type: 'subagent_task' }>>()
  for (const record of records) {
    if (record.type === 'subagent_task') latestTasks.set(record.agentId, record)
  }

  const interruptions: SessionRecord[] = []
  for (const agentId of orphaned) {
    const previous = latestTasks.get(agentId)
    if (!previous || previous.status !== 'running') continue
    interruptions.push({
      ...previous,
      id: createId(),
      status: 'interrupted',
      error: 'Background agent was not present when the session resumed',
      createdAt: now(),
    })
  }
  return interruptions
}
