import type {
  CommandSubagentCleanupResult,
  CommandSubagentDetails,
} from '../commands/types.js'
import type { SessionRecord } from '../harness/types.js'
import { SidechainRecordStream } from '../harness/sidechainRecordStream.js'
import { GitSubagentWorktreeManager } from '../services/agents/subagentWorktree.js'
import type { SessionStore } from '../sessions/service.js'

/**
 * Reading back what subagents did, for `/agents list|show|cleanup`.
 *
 * Framework-agnostic on purpose: these run identically behind the TUI's
 * `useCommands` hook and behind the host-side `CommandContext` a renderer
 * drives over the protocol. Nothing here holds state — every call re-reads the
 * session, because a background agent may have written since the last one.
 */

type SubagentTaskRecord = Extract<SessionRecord, { type: 'subagent_task' }>
type SubagentTranscriptRecord = Extract<SessionRecord, { type: 'subagent_transcript' }>

export async function listLatestSubagentTasks(
  store: SessionStore,
  sessionId: string,
): Promise<SubagentTaskRecord[]> {
  const loaded = await store.loadRecordsWithDiagnostics(sessionId)
  return latestSubagentTasks(loaded.records)
}

export async function getSubagentDetails(
  store: SessionStore,
  sessionId: string,
  agentIdOrPrefix: string,
): Promise<CommandSubagentDetails | null> {
  const loaded = await store.loadRecordsWithDiagnostics(sessionId)
  const tasks = latestSubagentTasks(loaded.records)
  const transcripts = latestSubagentTranscripts(loaded.records)
  const agentId = resolveAgentId(agentIdOrPrefix, tasks, transcripts)
  if (!agentId) return null

  const task = tasks.find((candidate) => candidate.agentId === agentId)
  const transcript = [...transcripts].reverse().find((candidate) => candidate.agentId === agentId)
  const transcriptPath = task?.transcriptPath ?? transcript?.transcriptPath
  const transcriptRecords = transcriptPath
    ? await new SidechainRecordStream(transcriptPath).load()
    : []

  return {
    task,
    transcript,
    transcriptRecords,
  }
}

export async function cleanupSubagentWorktrees(
  store: SessionStore,
  sessionId: string,
  cwd: string,
  apply: boolean,
): Promise<CommandSubagentCleanupResult> {
  const loaded = await store.loadRecordsWithDiagnostics(sessionId)
  const tasks = latestSubagentTasks(loaded.records)
  const manager = new GitSubagentWorktreeManager()
  const entries = []

  for (const task of tasks) {
    if (!task.worktreePath || task.status === 'running') continue
    try {
      const inspection = await manager.inspect({ worktreePath: task.worktreePath })
      const cleanup = apply && inspection.exists
        ? await manager.cleanup({ cwd, worktreePath: task.worktreePath })
        : undefined
      entries.push({
        agentId: task.agentId,
        status: task.status,
        worktreePath: task.worktreePath,
        exists: inspection.exists,
        removed: cleanup?.removed,
      })
    } catch (error) {
      entries.push({
        agentId: task.agentId,
        status: task.status,
        worktreePath: task.worktreePath,
        exists: false,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return {
    dryRun: !apply,
    entries,
  }
}

/** Last record wins: an agent's status is whatever it was written as most recently. */
export function latestSubagentTasks(records: SessionRecord[]): SubagentTaskRecord[] {
  const byAgentId = new Map<string, SubagentTaskRecord>()
  for (const record of records) {
    if (record.type === 'subagent_task') {
      byAgentId.set(record.agentId, record)
    }
  }
  return [...byAgentId.values()]
}

export function latestSubagentTranscripts(records: SessionRecord[]): SubagentTranscriptRecord[] {
  const byAgentId = new Map<string, SubagentTranscriptRecord>()
  for (const record of records) {
    if (record.type === 'subagent_transcript') {
      byAgentId.set(record.agentId, record)
    }
  }
  return [...byAgentId.values()]
}

/** Throws on an ambiguous prefix rather than picking one, and lists the candidates. */
export function resolveAgentId(
  agentIdOrPrefix: string,
  tasks: SubagentTaskRecord[],
  transcripts: SubagentTranscriptRecord[],
): string | null {
  const ids = new Set<string>()
  for (const task of tasks) ids.add(task.agentId)
  for (const transcript of transcripts) ids.add(transcript.agentId)

  if (ids.has(agentIdOrPrefix)) return agentIdOrPrefix
  const matches = [...ids].filter((id) => id.startsWith(agentIdOrPrefix))
  if (matches.length === 0) return null
  if (matches.length > 1) {
    throw new Error(`Ambiguous subagent id ${agentIdOrPrefix}: ${matches.map((id) => id.slice(0, 8)).join(', ')}`)
  }
  return matches[0] ?? null
}
