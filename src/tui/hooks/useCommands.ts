import { useCallback, useRef } from 'react'
import { useApp } from 'ink'
import { getCommand } from '../../commands/index.js'
import type {
  CommandContext,
  CommandModelInfo,
  CommandSubagentCleanupResult,
  CommandSubagentDetails,
  SetModelResult,
} from '../../commands/types.js'
import type { SessionStore, SessionMeta } from '../../sessions/service.js'
import type { ModelPricing, SessionRecord, TokenUsage } from '../../harness/types.js'
import { calculateTokenCost, hasCompletePricing } from '../../harness/usage.js'
import { resetAutoCompactFailureState } from '../../harness/compact.js'
import { SidechainRecordStream } from '../../harness/sidechainRecordStream.js'
import { GitSubagentWorktreeManager } from '../../services/agents/subagentWorktree.js'

interface UseCommandsOptions {
  store: SessionStore
  session: SessionMeta
  cwd: string
  model: CommandModelInfo
  setModel: (model: string) => void | SetModelResult | Promise<void | SetModelResult>
  pricing?: ModelPricing
  usage: { lastTurn: TokenUsage | null; total: TokenUsage }
  addSystemMessage: (content: string) => void
  clearMessages: () => void | Promise<void>
  clearCachedSections?: () => void
  invalidateRecordsCache?: () => void
  runVerification?: (args: string) => Promise<string>
  reloadAgentDefinitions?: () => Promise<number>
  getPermissionMode?: () => string
  setPermissionMode?: (mode: string) => void | Promise<void>
  enterPlanMode?: () => void | Promise<void>
  readPlanFile?: () => Promise<{ path: string; content: string | null }>
  openPlanFile?: () => Promise<{ message: string }>
  submitQuery?: (input: string) => Promise<void>
  openProviderPanel?: () => void
}

export function useCommands({
  store,
  session,
  cwd,
  model,
  setModel,
  pricing,
  usage,
  addSystemMessage,
  clearMessages,
  clearCachedSections,
  invalidateRecordsCache,
  runVerification,
  reloadAgentDefinitions,
  getPermissionMode,
  setPermissionMode,
  enterPlanMode,
  readPlanFile,
  openPlanFile,
  submitQuery,
  openProviderPanel,
}: UseCommandsOptions) {
  const { exit } = useApp()

  // Mirror the live values in refs so dispatch can read the latest data
  // without listing the parent objects in deps. These assignments happen
  // during render intentionally: App.tsx re-creates `model` (and sometimes
  // `session`) as fresh object literals on every render, and also rebuilds
  // callbacks such as `runVerification` when runtime changes. Depending on
  // those identities would rebuild dispatch each streaming chunk, while a
  // passive effect could leave a just-committed dispatch briefly pointing at
  // stale command context. Keying on stable scalars (session.id, model.key)
  // keeps dispatch stable while the refs ensure we still read fresh fields
  // when invoked.
  const sessionRef = useRef(session)
  sessionRef.current = session
  const modelRef = useRef(model)
  modelRef.current = model
  const setModelRef = useRef(setModel)
  setModelRef.current = setModel
  const pricingRef = useRef(pricing)
  pricingRef.current = pricing
  const usageRef = useRef(usage)
  usageRef.current = usage
  const addSystemMessageRef = useRef(addSystemMessage)
  addSystemMessageRef.current = addSystemMessage
  const clearMessagesRef = useRef(clearMessages)
  clearMessagesRef.current = clearMessages
  const clearCachedSectionsRef = useRef(clearCachedSections)
  clearCachedSectionsRef.current = clearCachedSections
  const invalidateRecordsCacheRef = useRef(invalidateRecordsCache)
  invalidateRecordsCacheRef.current = invalidateRecordsCache
  const runVerificationRef = useRef(runVerification)
  runVerificationRef.current = runVerification
  const reloadAgentDefinitionsRef = useRef(reloadAgentDefinitions)
  reloadAgentDefinitionsRef.current = reloadAgentDefinitions
  const getPermissionModeRef = useRef(getPermissionMode)
  getPermissionModeRef.current = getPermissionMode
  const setPermissionModeRef = useRef(setPermissionMode)
  setPermissionModeRef.current = setPermissionMode
  const enterPlanModeRef = useRef(enterPlanMode)
  enterPlanModeRef.current = enterPlanMode
  const readPlanFileRef = useRef(readPlanFile)
  readPlanFileRef.current = readPlanFile
  const openPlanFileRef = useRef(openPlanFile)
  openPlanFileRef.current = openPlanFile
  const submitQueryRef = useRef(submitQuery)
  submitQueryRef.current = submitQuery
  const openProviderPanelRef = useRef(openProviderPanel)
  openProviderPanelRef.current = openProviderPanel
  const storeRef = useRef(store)
  storeRef.current = store
  const cwdRef = useRef(cwd)
  cwdRef.current = cwd

  const dispatch = useCallback(
    async (input: string): Promise<boolean> => {
      if (!input.startsWith('/')) return false

      const spaceIdx = input.indexOf(' ')
      const name = spaceIdx >= 0 ? input.slice(1, spaceIdx) : input.slice(1)
      const args = spaceIdx >= 0 ? input.slice(spaceIdx + 1).trim() : ''

      // Handle /exit directly
      if (name === 'exit') {
        exit()
        return true
      }

      const command = getCommand(name)
      if (!command) {
        addSystemMessageRef.current(`Unknown command: /${name}. Type /help for available commands.`)
        return true
      }

      const context: CommandContext = {
        cwd: cwdRef.current,
        sessionId: sessionRef.current.id,
        writeLine: addSystemMessageRef.current,
        clearMessages: clearMessagesRef.current,
        clearCachedSections: clearCachedSectionsRef.current,
        invalidateRecordsCache: invalidateRecordsCacheRef.current,
        repairRecords: async () => storeRef.current.repairRecords(sessionRef.current.id),
        resetCompactFailureCount: async () => {
          await storeRef.current.setCompactFailureCount(sessionRef.current.id, 0)
          resetAutoCompactFailureState(sessionRef.current.id)
        },
        getUsage: () => {
          const total = usageRef.current.total
          const currentPricing = pricingRef.current
          if (!hasCompletePricing(currentPricing)) {
            return total
          }
          return {
            ...total,
            cost: calculateTokenCost(total, currentPricing),
            currency: currentPricing.currency ?? 'USD',
          }
        },
        getSessionMetricsSummary: async () => storeRef.current.loadMetricsSummary(sessionRef.current.id),
        getModel: () => modelRef.current,
        setModel: (m) => setModelRef.current(m),
        runVerification: runVerificationRef.current,
        reloadAgentDefinitions: reloadAgentDefinitionsRef.current,
        getPermissionMode: getPermissionModeRef.current,
        setPermissionMode: setPermissionModeRef.current,
        enterPlanMode: enterPlanModeRef.current,
        readPlanFile: readPlanFileRef.current,
        openPlanFile: openPlanFileRef.current,
        submitQuery: submitQueryRef.current,
        openProviderPanel: openProviderPanelRef.current,
        listSubagentTasks: async () => listLatestSubagentTasks(storeRef.current, sessionRef.current.id),
        getSubagentDetails: async (agentIdOrPrefix) => getSubagentDetails(
          storeRef.current,
          sessionRef.current.id,
          agentIdOrPrefix,
        ),
        cleanupSubagentWorktrees: async ({ apply }) => cleanupSubagentWorktrees(
          storeRef.current,
          sessionRef.current.id,
          cwdRef.current,
          apply,
        ),
      }

      try {
        await command.run(args, context)
      } catch (err) {
        addSystemMessageRef.current(
          `Command error: ${err instanceof Error ? err.message : String(err)}`,
        )
      }

      return true
    },
    // Only the identity scalars participate in keying. Everything else is
    // read via refs above, so dispatch stays stable while still seeing fresh
    // data on each invocation.
    [session.id, model.key, exit],
  )

  return { dispatch }
}

type SubagentTaskRecord = Extract<SessionRecord, { type: 'subagent_task' }>
type SubagentTranscriptRecord = Extract<SessionRecord, { type: 'subagent_transcript' }>

async function listLatestSubagentTasks(store: SessionStore, sessionId: string): Promise<SubagentTaskRecord[]> {
  const loaded = await store.loadRecordsWithDiagnostics(sessionId)
  return latestSubagentTasks(loaded.records)
}

async function getSubagentDetails(
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
  const transcript = transcripts.find((candidate) => candidate.agentId === agentId)
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

async function cleanupSubagentWorktrees(
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

function latestSubagentTasks(records: SessionRecord[]): SubagentTaskRecord[] {
  const byAgentId = new Map<string, SubagentTaskRecord>()
  for (const record of records) {
    if (record.type === 'subagent_task') {
      byAgentId.set(record.agentId, record)
    }
  }
  return [...byAgentId.values()]
}

function latestSubagentTranscripts(records: SessionRecord[]): SubagentTranscriptRecord[] {
  const byAgentId = new Map<string, SubagentTranscriptRecord>()
  for (const record of records) {
    if (record.type === 'subagent_transcript') {
      byAgentId.set(record.agentId, record)
    }
  }
  return [...byAgentId.values()]
}

function resolveAgentId(
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
