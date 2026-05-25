import { useCallback, useRef } from 'react'
import { useApp } from 'ink'
import { getCommand } from '../../commands/index.js'
import type { CommandContext, CommandModelInfo, SetModelResult } from '../../commands/types.js'
import type { SessionStore, SessionMeta } from '../../sessions/service.js'
import type { ModelPricing, TokenUsage } from '../../harness/types.js'
import { calculateTokenCost, hasCompletePricing } from '../../harness/usage.js'
import { resetAutoCompactFailureState } from '../../harness/compact.js'

interface UseCommandsOptions {
  store: SessionStore
  session: SessionMeta
  cwd: string
  model: CommandModelInfo
  setModel: (model: string) => void | SetModelResult | Promise<void | SetModelResult>
  pricing?: ModelPricing
  usage: { current: TokenUsage | null; total: TokenUsage }
  addSystemMessage: (content: string) => void
  clearMessages: () => void | Promise<void>
  clearCachedSections?: () => void
  invalidateRecordsCache?: () => void
  runVerification?: (args: string) => Promise<string>
  reloadAgentDefinitions?: () => Promise<number>
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
