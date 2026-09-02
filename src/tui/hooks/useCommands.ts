import { useCallback, useRef } from 'react'
import { useApp } from 'ink'
import type { CommandRegistry } from '../../commands/registry.js'
import type {
  CommandContext,
  CommandModelInfo,
  CommandShellResult,
  CommandSubmitQueryOptions,
  CommandSubagentCleanupResult,
  CommandSubagentDetails,
  CommandView,
  SetModelResult,
} from '../../commands/types.js'
import type { SessionStore, SessionMeta } from '../../sessions/service.js'
import type { ModelPricing, TokenUsage } from '../../harness/types.js'
import { resolveUsageWithCost } from '../../harness/usage.js'
import { resetAutoCompactFailureState } from '../../harness/compact.js'
import {
  cleanupSubagentWorktrees,
  getSubagentDetails,
  listLatestSubagentTasks,
} from '../../runtime/subagentInspection.js'

interface UseCommandsOptions {
  store: SessionStore
  session: SessionMeta
  /** This project's slash commands. See `ProjectRuntime.commands`. */
  commands: CommandRegistry
  cwd: string
  model: CommandModelInfo
  setModel: (model: string) => void | SetModelResult | Promise<void | SetModelResult>
  pricing?: ModelPricing
  usage: { lastRequest: TokenUsage | null; total: TokenUsage }
  addSystemMessage: (content: string) => void
  openCommandView?: (view: CommandView) => void
  clearMessages: () => void | Promise<void>
  clearCachedSections?: () => void
  invalidateRecordsCache?: () => void
  reloadAgentDefinitions?: () => Promise<number>
  reloadSkills?: () => Promise<number>
  getPermissionMode?: () => string
  enterPlanMode?: () => void | Promise<void>
  readPlanFile?: () => Promise<{ path: string; content: string | null }>
  openPlanFile?: () => Promise<{ message: string }>
  submitQuery?: (input: string, options?: CommandSubmitQueryOptions) => Promise<void>
  runShellCommand?: (command: string) => Promise<CommandShellResult>
  openModelPicker?: () => void
  openEffortPicker?: () => void
  openProviderPanel?: () => void
  openBackgroundTasks?: () => void
  openResumePicker?: () => void
  openRewindPanel?: () => void
  getEffort?: () => string
  setEffort?: (level: string) => void | Promise<void>
  getThinking?: () => boolean
  setThinking?: (enabled: boolean) => void | Promise<void>
}

export function useCommands({
  store,
  session,
  commands,
  cwd,
  model,
  setModel,
  pricing,
  usage,
  addSystemMessage,
  openCommandView,
  clearMessages,
  clearCachedSections,
  invalidateRecordsCache,
  reloadAgentDefinitions,
  reloadSkills,
  getPermissionMode,
  enterPlanMode,
  readPlanFile,
  openPlanFile,
  submitQuery,
  openModelPicker,
  openEffortPicker,
  openProviderPanel,
  openBackgroundTasks,
  openResumePicker,
  openRewindPanel,
  getEffort,
  setEffort,
  getThinking,
  setThinking,
  runShellCommand,
}: UseCommandsOptions) {
  const { exit } = useApp()

  // Mirror the live values in refs so dispatch can read the latest data
  // without listing the parent objects in deps. These assignments happen
  // during render intentionally: App.tsx re-creates `model` (and sometimes
  // `session`) as fresh object literals on every render, and also rebuilds
  // callbacks when runtime changes. Depending on
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
  const openCommandViewRef = useRef(openCommandView)
  openCommandViewRef.current = openCommandView
  const clearMessagesRef = useRef(clearMessages)
  clearMessagesRef.current = clearMessages
  const clearCachedSectionsRef = useRef(clearCachedSections)
  clearCachedSectionsRef.current = clearCachedSections
  const invalidateRecordsCacheRef = useRef(invalidateRecordsCache)
  invalidateRecordsCacheRef.current = invalidateRecordsCache
  const reloadAgentDefinitionsRef = useRef(reloadAgentDefinitions)
  reloadAgentDefinitionsRef.current = reloadAgentDefinitions
  const reloadSkillsRef = useRef(reloadSkills)
  reloadSkillsRef.current = reloadSkills
  const getPermissionModeRef = useRef(getPermissionMode)
  getPermissionModeRef.current = getPermissionMode
  const enterPlanModeRef = useRef(enterPlanMode)
  enterPlanModeRef.current = enterPlanMode
  const readPlanFileRef = useRef(readPlanFile)
  readPlanFileRef.current = readPlanFile
  const openPlanFileRef = useRef(openPlanFile)
  openPlanFileRef.current = openPlanFile
  const submitQueryRef = useRef(submitQuery)
  submitQueryRef.current = submitQuery
  const runShellCommandRef = useRef(runShellCommand)
  runShellCommandRef.current = runShellCommand
  const openModelPickerRef = useRef(openModelPicker)
  openModelPickerRef.current = openModelPicker
  const openEffortPickerRef = useRef(openEffortPicker)
  openEffortPickerRef.current = openEffortPicker
  const openProviderPanelRef = useRef(openProviderPanel)
  openProviderPanelRef.current = openProviderPanel
  const openBackgroundTasksRef = useRef(openBackgroundTasks)
  openBackgroundTasksRef.current = openBackgroundTasks
  const openResumePickerRef = useRef(openResumePicker)
  openResumePickerRef.current = openResumePicker
  const openRewindPanelRef = useRef(openRewindPanel)
  openRewindPanelRef.current = openRewindPanel
  const getEffortRef = useRef(getEffort)
  getEffortRef.current = getEffort
  const setEffortRef = useRef(setEffort)
  setEffortRef.current = setEffort
  const getThinkingRef = useRef(getThinking)
  getThinkingRef.current = getThinking
  const setThinkingRef = useRef(setThinking)
  setThinkingRef.current = setThinking
  const storeRef = useRef(store)
  storeRef.current = store
  const cwdRef = useRef(cwd)
  cwdRef.current = cwd
  const commandsRef = useRef(commands)
  commandsRef.current = commands

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

      const command = commandsRef.current.get(name)
      if (!command) {
        addSystemMessageRef.current(`Unknown command: /${name}. Type /help for available commands.`)
        return true
      }

      const context: CommandContext = {
        cwd: cwdRef.current,
        sessionId: sessionRef.current.id,
        writeLine: addSystemMessageRef.current,
        openCommandView: openCommandViewRef.current,
        clearMessages: clearMessagesRef.current,
        clearCachedSections: clearCachedSectionsRef.current,
        invalidateRecordsCache: invalidateRecordsCacheRef.current,
        repairRecords: async () => storeRef.current.repairRecords(sessionRef.current.id),
        resetCompactFailureCount: async () => {
          await storeRef.current.setCompactFailureCount(sessionRef.current.id, 0)
          resetAutoCompactFailureState(sessionRef.current.id)
        },
        getUsage: () => resolveUsageWithCost(usageRef.current.total, pricingRef.current),
        getSessionMetricsSummary: async () => storeRef.current.loadMetricsSummary(sessionRef.current.id),
        getModel: () => modelRef.current,
        setModel: (m) => setModelRef.current(m),
        getEffort: getEffortRef.current ? () => getEffortRef.current!() : undefined,
        setEffort: setEffortRef.current ? (level) => setEffortRef.current!(level) : undefined,
        getThinking: getThinkingRef.current ? () => getThinkingRef.current!() : undefined,
        setThinking: setThinkingRef.current ? (enabled) => setThinkingRef.current!(enabled) : undefined,
        reloadAgentDefinitions: reloadAgentDefinitionsRef.current,
        reloadSkills: reloadSkillsRef.current,
        getPermissionMode: getPermissionModeRef.current,
        enterPlanMode: enterPlanModeRef.current,
        readPlanFile: readPlanFileRef.current,
        openPlanFile: openPlanFileRef.current,
        submitQuery: submitQueryRef.current,
        runShellCommand: runShellCommandRef.current,
        openModelPicker: openModelPickerRef.current,
        openEffortPicker: openEffortPickerRef.current,
        openProviderPanel: openProviderPanelRef.current,
        openBackgroundTasks: openBackgroundTasksRef.current,
        openResumePicker: openResumePickerRef.current,
        openRewindPanel: openRewindPanelRef.current,
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
