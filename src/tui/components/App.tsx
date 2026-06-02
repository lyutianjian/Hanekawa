import { useState, useCallback, useRef, useEffect, useMemo } from 'react'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { Box, Static } from '../ink.js'
import type { AgentLoop } from '../../harness/loop.js'
import type { SessionStore, SessionMeta } from '../../sessions/service.js'
import type { PermissionGate, PermissionMode } from '../../harness/permissions.js'
import type { PlanModeManager } from '../../harness/planModeManager.js'
import type { ConfigService, ModelConfig } from '../../config/service.js'
import { resolveTier, type Tier } from '../../config/routing.js'
import type { SessionRecord } from '../../harness/types.js'
import type { SetModelResult } from '../../commands/types.js'
import type { TUIDisplayItem, TUIStaticItem } from '../types.js'
import { useAgentLoop } from '../hooks/useAgentLoop.js'
import { useKeyboardShortcuts } from '../hooks/useKeyboardShortcuts.js'
import { useCommands } from '../hooks/useCommands.js'
import { usePermission } from '../hooks/usePermission.js'
import type { PermissionPromptProxy, RecordProxy } from '../hooks/usePermission.js'
import { CheckpointService } from '../../services/checkpoint/checkpointService.js'
import type { Checkpoint } from '../../services/checkpoint/checkpointService.js'
import { MessageList, StaticDisplayItem } from './MessageList.js'
import { InputBox } from './InputBox.js'
import { CommandSuggestions } from './CommandSuggestions.js'
import { sampleSpinnerColors, Spinner } from './Spinner.js'
import { TaskListBlock } from './TaskListBlock.js'
import { PermissionDialog } from './PermissionDialog.js'
import { StatusLine } from './StatusLine.js'
import { RestoreMode } from './RestoreMode.js'
import { invalidateResolvedCwdCache } from '../../utils/paths.js'
import { readPlan } from '../../utils/plans.js'
import { applyPermissionModeTransition, nextPermissionMode } from '../permissionMode.js'
import { ExitPlanModeDialog } from './ExitPlanModeDialog.js'
import { EnterPlanModeDialog } from './EnterPlanModeDialog.js'
import { AskUserQuestionDialog } from './AskUserQuestionDialog.js'
import { ProviderPanel } from './ProviderPanel.js'
import { ModelPickerDialog, type ModelPickerDecision, type ModelPickerOption } from './ModelPickerDialog.js'
import { useExitPlanPermission, type ExitPlanPromptProxy } from '../hooks/useExitPlanPermission.js'
import { useEnterPlanPermission, type EnterPlanPromptProxy } from '../hooks/useEnterPlanPermission.js'
import { useAskUserQuestionPermission, type AskUserQuestionProxy } from '../hooks/useAskUserQuestionPermission.js'

export type AppMode = 'idle' | 'running' | 'restore' | 'exiting'

const ABORT_TIMEOUT_MS = 2000
const VERIFICATION_TASK_MAX_CHARS = 60_000

export interface AppRuntime {
  loop: AgentLoop
  planModeManager: PlanModeManager
  modelKey: string
  modelConfig: ModelConfig
  providerName: string
  dispose: () => void
}

interface AppProps {
  loop: AgentLoop
  planModeManager: PlanModeManager
  modelKey: string
  store: SessionStore
  session: SessionMeta
  modelConfig: ModelConfig
  providerName: string
  dispose: () => void
  availableModelKeys: string[]
  resolveModelInput: (input: string, currentModelKey: string) => string | undefined
  providerConfig: ConfigService
  createRuntime: (modelKey: string, session: SessionMeta) => AppRuntime
  permissionGate: PermissionGate
  promptProxy: PermissionPromptProxy
  recordProxy: RecordProxy
  exitPlanProxy: ExitPlanPromptProxy
  enterPlanProxy: EnterPlanPromptProxy
  askUserQuestionProxy: AskUserQuestionProxy
  existingRecords: SessionRecord[]
  initialSystemMessages?: TUIDisplayItem[]
  initialQueuedPrompt?: string
  onBeforeExit?: () => Promise<void>
  onPermissionModeChange?: (mode: PermissionMode) => Promise<void> | void
  reloadAgentDefinitions?: () => Promise<number>
}

export function App({
  loop: initialLoop,
  planModeManager: initialPlanModeManager,
  modelKey: initialModelKey,
  store,
  session: initialSession,
  modelConfig: initialModelConfig,
  providerName: initialProviderName,
  dispose: initialDispose,
  availableModelKeys,
  resolveModelInput,
  providerConfig,
  createRuntime,
  permissionGate,
  promptProxy,
  recordProxy,
  exitPlanProxy,
  enterPlanProxy,
  askUserQuestionProxy,
  existingRecords,
  initialSystemMessages,
  initialQueuedPrompt,
  onBeforeExit,
  onPermissionModeChange,
  reloadAgentDefinitions: reloadRuntimeAgentDefinitions,
}: AppProps) {
  const [mode, setMode] = useState<AppMode>('idle')
  const [activeSession, setActiveSession] = useState<SessionMeta>(initialSession)
  const [runtime, setRuntime] = useState<AppRuntime>(() => ({
    loop: initialLoop,
    planModeManager: initialPlanModeManager,
    modelKey: initialModelKey,
    modelConfig: initialModelConfig,
    providerName: initialProviderName,
    dispose: initialDispose,
  }))
  const runtimeRef = useRef<AppRuntime>(runtime)
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([])
  const [permissionMode, setPermissionModeState] = useState<PermissionMode>(() => permissionGate.getMode())
  const [modelKeys, setModelKeys] = useState<string[]>(availableModelKeys)
  const [providerPanelOpen, setProviderPanelOpen] = useState(false)
  const [modelPickerOpen, setModelPickerOpen] = useState(false)
  const abortTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const verifyAbortRef = useRef<AbortController | null>(null)
  const [spinnerColors, setSpinnerColors] = useState(() => sampleSpinnerColors())
  const checkpointServiceRef = useRef<CheckpointService>(
    new CheckpointService(process.cwd(), initialSession.id),
  )
  const [queuedPromptAfterClear, setQueuedPromptAfterClear] = useState<string | null>(initialQueuedPrompt ?? null)

  const { permState, respond, setActiveRequest, denyPending } = usePermission(promptProxy)
  const exitPlan = useExitPlanPermission(exitPlanProxy)
  const enterPlan = useEnterPlanPermission(enterPlanProxy)
  const askUserQuestion = useAskUserQuestionPermission(askUserQuestionProxy)

  const replaceRuntime = useCallback((nextRuntime: AppRuntime) => {
    const previousRuntime = runtimeRef.current
    runtimeRef.current = nextRuntime
    previousRuntime.dispose()
    setRuntime(nextRuntime)
  }, [])

  useEffect(() => {
    runtimeRef.current = runtime
  }, [runtime])

  useEffect(() => {
    setModelKeys(availableModelKeys)
  }, [availableModelKeys])

  useEffect(() => {
    return () => {
      runtimeRef.current.dispose()
    }
  }, [])

  useEffect(() => {
    setPermissionModeState(permissionGate.getMode())
    return permissionGate.onModeChange((nextMode) => {
      setPermissionModeState(nextMode)
      void onPermissionModeChange?.(nextMode)
    })
  }, [permissionGate, onPermissionModeChange])

  const syncActiveModel = useCallback((activeModel: { modelKey?: string }) => {
    if (!activeModel.modelKey) return
    if (activeModel.modelKey === runtime.modelKey) return
    const nextRuntime = createRuntime(activeModel.modelKey, activeSession)
    nextRuntime.dispose()
    setRuntime((current) => {
      if (current.modelKey === activeModel.modelKey) return current
      return {
        ...nextRuntime,
        loop: current.loop,
        planModeManager: current.planModeManager,
        dispose: current.dispose,
      }
    })
  }, [createRuntime, activeSession, runtime.modelKey])

  const {
    staticTranscriptItems,
    liveItems,
    recentCompletedToolCall,
    transcriptGeneration,
    appendStaticItem,
    resetTranscript,
    isStreaming,
    spinnerSubText,
    taskSnapshot,
    usage,
    submit,
    interrupt,
    reloadMessages,
  } = useAgentLoop({
    loop: runtime.loop,
    store,
    session: activeSession,
    permissionGate,
    recordProxy,
    existingRecords,
    initialSystemMessages,
    onActiveModelChange: syncActiveModel,
    onInterrupt: denyPending,
  })

  // Track running state in mode
  // When isStreaming changes, update mode accordingly
  const effectiveMode: AppMode = isStreaming ? 'running' : mode
  const isOverlayActive = permState.visible
    || exitPlan.state.visible
    || enterPlan.state.visible
    || askUserQuestion.state.visible
    || providerPanelOpen
    || modelPickerOpen
    || mode === 'restore'
  const showSpinner = !isOverlayActive
  const showStoppedTaskList = !isStreaming
    && !isOverlayActive
    && taskSnapshot !== undefined
    && taskSnapshot.counts.remaining > 0

  // Helper to add system messages from commands
  const addSystemMessage = useCallback((content: string) => {
    const systemMsg: TUIDisplayItem = {
      kind: 'system',
      id: randomUUID(),
      content,
      createdAt: new Date().toISOString(),
    }
    appendStaticItem(systemMsg)
  }, [appendStaticItem])

  const clearConversation = useCallback(async () => {
    runtime.loop.clearCachedSections()
    const nextSession = await store.create()
    const nextRuntime = createRuntime(runtime.modelKey, nextSession)
    checkpointServiceRef.current = new CheckpointService(process.cwd(), nextSession.id)
    setActiveSession(nextSession)
    replaceRuntime(nextRuntime)
    setCheckpoints([])
    resetTranscript([])
  }, [store, createRuntime, runtime.modelKey, runtime.loop, replaceRuntime, resetTranscript])

  const submitPlainInput = useCallback(async (text: string) => {
    setSpinnerColors(sampleSpinnerColors())
    setMode('running')
    try {
      await submit(text)
    } finally {
      setMode('idle')
    }
  }, [submit])

  useEffect(() => {
    if (!queuedPromptAfterClear || isStreaming || mode !== 'idle') return
    const prompt = queuedPromptAfterClear
    setQueuedPromptAfterClear(null)
    void submitPlainInput(prompt)
  }, [queuedPromptAfterClear, isStreaming, mode, submitPlainInput])

  const activateModelKey = useCallback((modelKey: string): SetModelResult => {
    if (!modelKeys.includes(modelKey)) {
      return {
        ok: false,
        message: `Unknown model: ${modelKey}`,
        availableModels: [...modelKeys, 'fast', 'balanced', 'powerful'],
      }
    }

    try {
      const nextRuntime = createRuntime(modelKey, activeSession)
      runtimeRef.current.loop.clearCachedSections()
      replaceRuntime(nextRuntime)
      return {
        ok: true,
        model: {
          key: nextRuntime.modelKey,
          model: nextRuntime.modelConfig.model,
          providerName: nextRuntime.providerName,
        },
      }
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : String(err),
        availableModels: [...modelKeys, 'fast', 'balanced', 'powerful'],
      }
    }
  }, [modelKeys, createRuntime, activeSession, replaceRuntime])

  const switchModel = useCallback((input: string): SetModelResult => {
    const modelKey = resolveModelInput(input, runtimeRef.current.modelKey)
    if (!modelKey) {
      return {
        ok: false,
        message: input.trim().toLowerCase() === 'inherit'
          ? '/model inherit is not supported. inherit is only valid in routing/subagent settings.'
          : `Unknown model or tier: ${input}`,
        availableModels: [...modelKeys, 'fast', 'balanced', 'powerful'],
      }
    }
    return activateModelKey(modelKey)
  }, [resolveModelInput, modelKeys, activateModelKey])

  const modelPickerOptions = useMemo(
    () => buildModelPickerOptions(providerConfig, runtime.modelKey, modelKeys),
    [providerConfig, runtime.modelKey, modelKeys],
  )

  const handleModelPickerResolve = useCallback(async (decision: ModelPickerDecision | { action: 'cancel' }) => {
    setModelPickerOpen(false)
    if (decision.action === 'cancel') return

    const modelKey = decision.option.modelKey
    if (!modelKey) {
      addSystemMessage(`Model tier unavailable: ${decision.option.label}`)
      return
    }

    if (decision.action === 'set-default') {
      try {
        providerConfig.setDefaultModel(modelKey)
        await providerConfig.save()
        setModelKeys(Object.keys(providerConfig.get().models))
      } catch (error) {
        addSystemMessage(`Failed to update default model: ${error instanceof Error ? error.message : String(error)}`)
        return
      }
    }

    const result = activateModelKey(modelKey)
    if (!result.ok) {
      addSystemMessage(result.message)
      return
    }

    const message = `Model set to: ${result.model.key} (${result.model.providerName}: ${result.model.model})`
    addSystemMessage(decision.action === 'set-default'
      ? `${message}\nDefault model updated.`
      : message)
  }, [providerConfig, activateModelKey, addSystemMessage])

  const runVerification = useCallback(async (args: string): Promise<string> => {
    setSpinnerColors(sampleSpinnerColors())
    setMode('running')
    const ac = new AbortController()
    verifyAbortRef.current = ac
    try {
      const loaded = await store.loadRecordsWithDiagnostics(activeSession.id)
      const task = buildVerificationTask(loaded.records, args)
      const result = await runtime.loop.runTool(
        {
          id: randomUUID(),
          name: 'Agent',
          input: {
            task,
            subagent_type: 'verification',
            maxTurns: 20,
          },
        },
        { signal: ac.signal },
      )
      if (!result.ok) {
        if (result.errorCode === 'aborted') return 'Verification interrupted.'
        return `Verification agent failed: ${result.content}`
      }
      return result.content
    } catch (err) {
      if (err instanceof Error && (err.name === 'AbortError' || (err as Error & { aborted?: boolean }).aborted)) {
        return 'Verification interrupted.'
      }
      throw err
    } finally {
      if (verifyAbortRef.current === ac) {
        verifyAbortRef.current = null
      }
      setMode('idle')
    }
  }, [store, activeSession.id, runtime.loop])

  const reloadAgentDefinitions = useCallback(async (): Promise<number> => {
    if (!reloadRuntimeAgentDefinitions) {
      throw new Error('Agent definition reload is not available in this runtime.')
    }
    const count = await reloadRuntimeAgentDefinitions()
    runtime.loop.clearCachedSections()
    const nextRuntime = createRuntime(runtime.modelKey, activeSession)
    replaceRuntime(nextRuntime)
    return count
  }, [reloadRuntimeAgentDefinitions, runtime.loop, runtime.modelKey, createRuntime, activeSession, replaceRuntime])

  const cyclePermissionMode = useCallback((direction: 1 | -1) => {
    setPermissionModeState((currentMode) => {
      const nextMode = nextPermissionMode(currentMode, direction)
      return applyPermissionModeTransition(permissionGate, runtimeRef.current.planModeManager, nextMode)
    })
  }, [permissionGate])

  useEffect(() => {
    runtime.planModeManager.setUiDeps({
      emitChatMessage: async (content) => addSystemMessage(content),
      openEnterPrompt: enterPlanProxy.open,
      openExitDialog: exitPlanProxy.open,
      onClearContextAndReplaceInput: async (content) => {
        await clearConversation()
        setQueuedPromptAfterClear(content)
      },
    })
  }, [runtime.planModeManager, addSystemMessage, enterPlanProxy, exitPlanProxy, clearConversation])

  const readCurrentPlanFile = useCallback(async () => {
    const path = runtimeRef.current.planModeManager.resolvePlanFilePathLazy()
    return { path, content: await readPlan(path) }
  }, [])

  const openCurrentPlanFile = useCallback(async (): Promise<{ message: string }> => {
    const { path } = await readCurrentPlanFile()
    const editor = process.env.VISUAL || process.env.EDITOR || (process.platform === 'win32' ? 'notepad' : 'nano')
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(editor, [path], { stdio: 'inherit' })
        child.on('error', reject)
        child.on('exit', (code) => {
          if (code === 0 || code === null) resolve()
          else reject(new Error(`editor exited with code ${code}`))
        })
      })
      return { message: `Opened plan in editor: ${path}` }
    } catch (error) {
      return { message: `Failed to open plan in editor: ${error instanceof Error ? error.message : String(error)}` }
    }
  }, [readCurrentPlanFile])

  const { dispatch } = useCommands({
    store,
    session: activeSession,
    cwd: process.cwd(),
    model: {
      key: runtime.modelKey,
      model: runtime.modelConfig.model,
      providerName: runtime.providerName,
    },
    setModel: switchModel,
    pricing: runtime.modelConfig.pricing,
    usage,
    addSystemMessage,
    clearMessages: clearConversation,
    clearCachedSections: () => runtime.loop.clearCachedSections(),
    invalidateRecordsCache: () => runtime.loop.invalidateRecordsCache(),
    runVerification,
    reloadAgentDefinitions,
    getPermissionMode: () => permissionGate.getMode(),
    enterPlanMode: () => {
      const mode = applyPermissionModeTransition(permissionGate, runtimeRef.current.planModeManager, 'plan')
      setPermissionModeState(mode)
    },
    readPlanFile: readCurrentPlanFile,
    openPlanFile: openCurrentPlanFile,
    submitQuery: submitPlainInput,
    openModelPicker: () => setModelPickerOpen(true),
    openProviderPanel: () => setProviderPanelOpen(true),
  })

  const handleSubmit = useCallback(async (text: string) => {
    if (text.startsWith('/')) {
      await dispatch(text)
      return
    }
    await submitPlainInput(text)
  }, [dispatch, submitPlainInput])

  const handleInterrupt = useCallback(() => {
    // Signal the AbortController to abort the agent loop
    interrupt()
    // Also abort any in-flight verification dispatched via runtime.loop.runTool.
    verifyAbortRef.current?.abort()

    // Set up abort timeout: if agent loop doesn't stop within 2s, force-terminate
    abortTimeoutRef.current = setTimeout(() => {
      // Force-terminate: the agent loop should have already stopped via AbortError,
      // but if it hasn't, we force the state back to idle
      setMode('idle')
      abortTimeoutRef.current = null
    }, ABORT_TIMEOUT_MS)

    // The "Interrupted." system message is already handled by useAgentLoop
    // when it catches the AbortError. We just need to clean up the timeout
    // when streaming stops (which happens in the effectiveMode logic).
  }, [interrupt])

  const handleExit = useCallback(() => {
    setMode('exiting')
    // If running, signal abort first to allow in-flight operations to terminate
    if (isStreaming) {
      interrupt()
    }
    verifyAbortRef.current?.abort()
    // Run cleanup (e.g., disconnect MCP clients) before exiting. Errors are
    // swallowed inside onBeforeExit; we only need to await the promise so
    // disconnects have a chance to flush before process.exit kills the loop.
    const finalizeAndExit = async () => {
      if (onBeforeExit) {
        try {
          await onBeforeExit()
        } catch {
          // Cleanup errors must not block exit.
        }
      }
      process.exit(0)
    }
    void finalizeAndExit()
  }, [isStreaming, interrupt, onBeforeExit])

  const handleEnterRestoreMode = useCallback(async () => {
    try {
      const cpService = checkpointServiceRef.current
      const cpList = await cpService.getCheckpoints()
      setCheckpoints(cpList)
      setMode('restore')
    } catch {
      // If fetching checkpoints fails, just stay in idle
      setCheckpoints([])
      setMode('restore')
    }
  }, [])

  const handleRestoreCancel = useCallback(() => {
    setMode('idle')
  }, [])

  const handleRestoreSelect = useCallback(async (checkpoint: Checkpoint) => {
    // Step 1: Truncate conversation history to the selected message
    const truncateResult = await store.truncateToMessage(activeSession.id, checkpoint.messageId)

    if (!truncateResult.success) {
      // Full failure: truncation failed, remain in restore mode
      // The error will be displayed by RestoreMode component via the thrown error
      throw new Error(truncateResult.error ?? 'Failed to truncate session')
    }

    // Step 2: Reload messages after successful truncation
    runtime.loop.invalidateRecordsCache()
    await reloadMessages()

    // Step 3: Attempt git checkout to restore file state
    const cpService = checkpointServiceRef.current
    const restoreResult = await cpService.restoreToCommit(checkpoint.commitHash)
    // git checkout can swap symlink targets (or replace symlinks with regular
    // files and vice versa), which invalidates the cwd's realpath cache used
    // by assertInsideCwd. Drop the cached entry so subsequent path checks
    // resolve against the post-checkout filesystem state.
    invalidateResolvedCwdCache(process.cwd())

    // Step 4: Format and display success/partial-failure message
    const messagePreview = checkpoint.messageContent.slice(0, 50)
    const timestamp = new Date(checkpoint.timestamp).toLocaleString()

    if (!restoreResult.success) {
      // Partial failure: truncation succeeded but git checkout failed
      // Add system message about partial restore, then return to idle
      const partialMsg: TUIDisplayItem = {
        kind: 'system',
        id: randomUUID(),
        content: `Conversation restored to "${messagePreview}" (${timestamp}), but file state could not be reverted: ${restoreResult.error}`,
        createdAt: new Date().toISOString(),
      }
      appendStaticItem(partialMsg)
      setMode('idle')
      return
    }

    // Full success: both truncation and git checkout succeeded
    const successMsg: TUIDisplayItem = {
      kind: 'system',
      id: randomUUID(),
      content: `Restored to "${messagePreview}" (${timestamp})`,
      createdAt: new Date().toISOString(),
    }
    appendStaticItem(successMsg)
    setMode('idle')
  }, [store, activeSession.id, reloadMessages, appendStaticItem])

  // Clean up abort timeout when streaming stops
  useEffect(() => {
    if (!isStreaming && abortTimeoutRef.current) {
      clearTimeout(abortTimeoutRef.current)
      abortTimeoutRef.current = null
    }
  }, [isStreaming])

  const {
    text,
    cursorPos,
    hintMessage,
    suggestions,
    selectedSuggestion,
    suggestionType,
  } = useKeyboardShortcuts({
    onSubmit: handleSubmit,
    onInterrupt: handleInterrupt,
    onExit: handleExit,
    onEnterRestoreMode: handleEnterRestoreMode,
    onCyclePermissionMode: cyclePermissionMode,
    isStreaming,
    isRestoreMode: mode === 'restore',
    isPermissionVisible:
      permState.visible
      || exitPlan.state.visible
      || enterPlan.state.visible
      || askUserQuestion.state.visible
      || providerPanelOpen
      || modelPickerOpen,
  })
  const staticItems: TUIStaticItem[] = [
    {
      kind: 'welcome_banner',
      id: `welcome-${activeSession.id}`,
      sessionShortId: activeSession.shortId,
      model: runtime.modelConfig.model,
      providerName: runtime.providerName,
      cwd: process.cwd(),
    },
    ...staticTranscriptItems,
  ]

  return (
    <Box flexDirection="column" width="100%">
      <Static key={transcriptGeneration} items={staticItems}>
        {(item) => <StaticDisplayItem key={item.id} item={item} />}
      </Static>

      {/* Message list */}
      <MessageList
        items={liveItems}
        recentCompletedToolCall={recentCompletedToolCall}
        isOverlayActive={isOverlayActive}
      />

      {/* Spinner during streaming */}
      {isStreaming && (
        <Spinner
          subText={spinnerSubText}
          taskSnapshot={taskSnapshot}
          spinnerColors={spinnerColors}
          active={showSpinner}
        />
      )}

      {showStoppedTaskList && (
        <Box paddingLeft={2}>
          <TaskListBlock snapshot={taskSnapshot} runningColor={spinnerColors.messageColor} />
        </Box>
      )}

      {/* Permission dialog */}
      {permState.visible && (
        <PermissionDialog permState={permState} respond={respond} setActiveRequest={setActiveRequest} />
      )}

      {enterPlan.state.visible && enterPlan.state.request && (
        <EnterPlanModeDialog
          onResolve={(approved) => enterPlan.respond(enterPlan.state.request!.id, approved)}
        />
      )}

      {exitPlan.state.visible && exitPlan.state.request && (
        <ExitPlanModeDialog
          {...exitPlan.state.request.input}
          onResolve={(decision) => exitPlan.respond(exitPlan.state.request!.id, decision)}
        />
      )}

      {askUserQuestion.state.visible && askUserQuestion.state.request && (
        <AskUserQuestionDialog
          request={askUserQuestion.state.request.input}
          onResolve={(result) => askUserQuestion.respond(askUserQuestion.state.request!.id, result)}
        />
      )}

      {/* Restore mode overlay */}
      {mode === 'restore' && (
        <RestoreMode
          checkpoints={checkpoints}
          onSelect={handleRestoreSelect}
          onCancel={handleRestoreCancel}
        />
      )}

      {providerPanelOpen && (
        <ProviderPanel
          config={providerConfig}
          onChange={() => {
            setModelKeys(Object.keys(providerConfig.get().models))
            runtimeRef.current.loop.clearCachedSections()
          }}
          onClose={() => setProviderPanelOpen(false)}
        />
      )}

      {modelPickerOpen && (
        <ModelPickerDialog
          options={modelPickerOptions}
          onResolve={(decision) => {
            void handleModelPickerResolve(decision)
          }}
        />
      )}

      {/* Input box (with horizontal lines) */}
      {mode !== 'restore' && !providerPanelOpen && !modelPickerOpen && (
        <InputBox
          text={text}
          cursorPos={cursorPos}
          disabled={
            isStreaming
            || permState.visible
            || exitPlan.state.visible
            || enterPlan.state.visible
            || askUserQuestion.state.visible
            || providerPanelOpen
            || modelPickerOpen
          }
        />
      )}

      {suggestionType === 'command' && suggestions.length > 0 && (
        <CommandSuggestions suggestions={suggestions} selectedIndex={selectedSuggestion} />
      )}

      {/* Status line (below input, no border) */}
      <StatusLine
        model={runtime.modelConfig.model}
        providerName={runtime.providerName}
        usage={usage}
        pricing={runtime.modelConfig.pricing}
        permissionMode={permissionMode}
        hintMessage={hintMessage}
      />
    </Box>
  )
}

const MODEL_PICKER_TIERS: Array<{ tier: Tier; label: string }> = [
  { tier: 'fast', label: 'Fast' },
  { tier: 'balanced', label: 'Balanced' },
  { tier: 'powerful', label: 'Powerful' },
]

function buildModelPickerOptions(
  config: ConfigService,
  currentModelKey: string,
  knownModelKeys: string[],
): ModelPickerOption[] {
  const defaultModelKey = config.resolveModelReference(config.get().defaultModel)
  return MODEL_PICKER_TIERS.map(({ tier, label }) => {
    const modelKey = resolveTierModelKey(config, tier, currentModelKey)
    if (!modelKey || !knownModelKeys.includes(modelKey)) {
      return {
        tier,
        label,
        disabledReason: 'No configured model resolves for this tier.',
        isCurrent: false,
        isDefault: false,
      }
    }

    const model = config.getModel(modelKey)
    if (!model) {
      return {
        tier,
        label,
        disabledReason: `Configured model "${modelKey}" could not be loaded.`,
        isCurrent: false,
        isDefault: false,
      }
    }

    return {
      tier,
      label,
      modelKey,
      providerName: model.provider ?? 'unknown',
      modelId: model.model,
      isCurrent: modelKey === currentModelKey,
      isDefault: modelKey === defaultModelKey,
    }
  })
}

function resolveTierModelKey(config: ConfigService, tier: Tier, currentModelKey: string): string | undefined {
  const routed = resolveTier(config.getActiveProfile()?.profile, tier)
  if (routed && config.getModel(routed)) return routed
  if (currentModelKey && config.getModel(currentModelKey)) return currentModelKey
  return config.resolveModelReference(config.get().defaultModel)
}

function buildVerificationTask(records: SessionRecord[], focus: string): string {
  const lastAssistantIndex = findLastIndex(records, (record) =>
    record.type === 'message' && record.role === 'assistant' && record.content.trim().length > 0
  )
  if (lastAssistantIndex < 0) {
    throw new Error('No assistant turn found to verify.')
  }

  const assistant = records[lastAssistantIndex]
  if (assistant?.type !== 'message') {
    throw new Error('No assistant turn found to verify.')
  }

  const previousUser = findLastBefore(records, lastAssistantIndex, (record) =>
    record.type === 'message' && record.role === 'user'
  )
  const turnRecords = assistant.turnId
    ? records.filter((record) => record.turnId === assistant.turnId)
    : records.slice(Math.max(0, lastAssistantIndex - 12), lastAssistantIndex + 1)

  const body = [
    'Adversarially verify the last assistant turn from the parent Hanekawa session.',
    '',
    'Do not modify the project. Independently inspect and exercise the claimed behavior. Do not trust the implementation notes or any tests the implementing assistant said it ran.',
    '',
    focus.trim() ? `User-specified verification focus:\n${focus.trim()}` : undefined,
    previousUser ? `Original user request:\n${previousUser.content}` : undefined,
    `Last assistant response:\n${assistant.content}`,
    `Relevant records from that turn:\n${formatRecordsForVerification(turnRecords)}`,
  ].filter((part): part is string => Boolean(part))

  return truncateMiddle(body.join('\n\n'), VERIFICATION_TASK_MAX_CHARS)
}

function findLastBefore(
  records: SessionRecord[],
  beforeIndex: number,
  predicate: (record: SessionRecord) => boolean,
): Extract<SessionRecord, { type: 'message' }> | undefined {
  for (let index = beforeIndex - 1; index >= 0; index--) {
    const record = records[index]
    if (record && predicate(record) && record.type === 'message') return record
  }
  return undefined
}

function findLastIndex<T>(items: T[], predicate: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index]
    if (item !== undefined && predicate(item)) return index
  }
  return -1
}

function formatRecordsForVerification(records: SessionRecord[]): string {
  return records.map((record) => {
    if (record.type === 'message') {
      return [
        `- message ${record.role}:`,
        indent(truncateMiddle(record.content, 10_000)),
      ].join('\n')
    }
    if (record.type === 'tool_use') {
      return [
        `- tool_use ${record.tool}:`,
        indent(truncateMiddle(JSON.stringify(record.input, null, 2), 4_000)),
      ].join('\n')
    }
    if (record.type === 'tool_result') {
      return [
        `- tool_result ${record.tool} (${record.ok ? 'ok' : 'failed'}):`,
        indent(truncateMiddle(record.content, 10_000)),
      ].join('\n')
    }
    return `- ${record.type}`
  }).join('\n\n')
}

function indent(text: string): string {
  return text.split('\n').map((line) => `  ${line}`).join('\n')
}

function truncateMiddle(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  const head = Math.floor(maxChars * 0.6)
  const tail = maxChars - head
  return [
    text.slice(0, head),
    `[truncated ${text.length - maxChars} chars]`,
    text.slice(text.length - tail),
  ].join('\n')
}
