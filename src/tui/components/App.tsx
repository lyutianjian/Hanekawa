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
import type { CheckpointWithDiff } from '../../services/checkpoint/checkpointService.js'
import { MessageList, StaticDisplayItem, DisplayItem } from './MessageList.js'
import { AlternateScreen } from './AlternateScreen.js'
import { TranscriptView } from './TranscriptView.js'
import { InputBox } from './InputBox.js'
import { CommandSuggestions } from './CommandSuggestions.js'
import { sampleSpinnerColors, Spinner } from './Spinner.js'
import { TaskListBlock } from './TaskListBlock.js'
import { PermissionDialog } from './PermissionDialog.js'
import { StatusLine } from './StatusLine.js'
import { RestoreMode, type RestoreDecision } from './RestoreMode.js'
import { invalidateResolvedCwdCache } from '../../utils/paths.js'
import { readPlan } from '../../utils/plans.js'
import { applyPermissionModeTransition, nextPermissionMode } from '../permissionMode.js'
import { ExitPlanModeDialog } from './ExitPlanModeDialog.js'
import { EnterPlanModeDialog } from './EnterPlanModeDialog.js'
import { AskUserQuestionDialog } from './AskUserQuestionDialog.js'
import { ProviderPanel } from './ProviderPanel.js'
import { ModelPickerDialog, type ModelPickerDecision, type ModelPickerOption } from './ModelPickerDialog.js'
import { EffortPickerBar } from './EffortPickerBar.js'
import { useExitPlanPermission, type ExitPlanPromptProxy } from '../hooks/useExitPlanPermission.js'
import { useEnterPlanPermission, type EnterPlanPromptProxy } from '../hooks/useEnterPlanPermission.js'
import { useAskUserQuestionPermission, type AskUserQuestionProxy } from '../hooks/useAskUserQuestionPermission.js'
import { buildRewindSummaryRewrite, type RewindSummaryDecision } from '../rewindSummary.js'
import { clampEffort, type EffortValue, type EffortLevel } from '../../config/effort.js'

export type AppMode = 'idle' | 'running' | 'restore' | 'exiting'

const ABORT_TIMEOUT_MS = 2000

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
  initialEffortLevel?: string
  onEffortLevelChange?: (level: string) => void
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
  initialEffortLevel,
  onEffortLevelChange,
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
  const [checkpoints, setCheckpoints] = useState<CheckpointWithDiff[]>([])
  const [permissionMode, setPermissionModeState] = useState<PermissionMode>(() => permissionGate.getMode())
  const [modelKeys, setModelKeys] = useState<string[]>(availableModelKeys)
  const [providerPanelOpen, setProviderPanelOpen] = useState(false)
  const [modelPickerOpen, setModelPickerOpen] = useState(false)
  const [effortPickerOpen, setEffortPickerOpen] = useState(false)
  const [effortLevel, setEffortLevel] = useState<string>(initialEffortLevel ?? 'high')
  const abortTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const restoreInputRef = useRef<(text: string) => void>(() => {})
  const [spinnerColors, setSpinnerColors] = useState(() => sampleSpinnerColors())
  const checkpointServiceRef = useRef<CheckpointService>(
    new CheckpointService(process.cwd(), initialSession.id),
  )
  const [queuedPromptAfterClear, setQueuedPromptAfterClear] = useState<string | null>(initialQueuedPrompt ?? null)
  const [screen, setScreen] = useState<'prompt' | 'transcript'>('prompt')

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

  const restoreInput = useCallback((text: string) => {
    restoreInputRef.current(text)
  }, [])

  const {
    staticTranscriptItems,
    liveItems,
    liveSystemItems,
    recentCompletedToolCall,
    recentThinkingAssistant,
    transcriptGeneration,
    appendStaticItem,
    resetTranscript,
    isStreaming,
    spinnerSubText,
    streamMode,
    taskSnapshot,
    usage,
    responseLengthRef,
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
    onRestoreInput: restoreInput,
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
    || effortPickerOpen
    || mode === 'restore'
    || screen === 'transcript'
  const animationsEnabled = !permState.visible
  const showSpinner = animationsEnabled && !isOverlayActive
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
      // Re-apply current effort clamped to new model's maxEffort
      const maxEffort = nextRuntime.modelConfig.maxEffort
      const clamped = clampEffort(effortLevel as EffortValue, maxEffort)
      const clampedLevel = typeof clamped === 'number' ? effortLevel : clamped
      if (clampedLevel !== effortLevel) setEffortLevel(clampedLevel)
      const effortLevelForLoop = typeof clamped === 'string' ? clamped as EffortLevel : undefined
      nextRuntime.loop.setEffort(effortLevelForLoop)
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

  const handleSetEffort = useCallback((level: string) => {
    const maxEffort = runtimeRef.current.modelConfig.maxEffort
    const clamped = clampEffort(level as EffortValue, maxEffort)
    const clampedLevel = typeof clamped === 'number' ? level : clamped
    setEffortLevel(clampedLevel)
    const effortLevel = typeof clamped === 'string' ? clamped as EffortLevel : undefined
    runtimeRef.current.loop.setEffort(effortLevel)
    onEffortLevelChange?.(clampedLevel)
  }, [onEffortLevelChange])

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
    openEffortPicker: () => setEffortPickerOpen(true),
    openProviderPanel: () => setProviderPanelOpen(true),
    getEffort: () => effortLevel,
    setEffort: handleSetEffort,
  })

  const handleSubmit = useCallback(async (text: string) => {
    if (text.startsWith('/')) {
      await dispatch(text)
      return
    }
    await submitPlainInput(text)
  }, [dispatch, submitPlainInput])

  const handleToggleTranscript = useCallback(() => {
    setScreen((s) => s === 'transcript' ? 'prompt' : 'transcript')
  }, [])

  const handleInterrupt = useCallback(() => {
    // Signal the AbortController to abort the agent loop
    interrupt('user-cancel')

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
      interrupt('exit')
    }
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
      const cpList = await cpService.getCheckpointsWithDiffs()
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

  const restoreConversationToCheckpoint = useCallback(async (checkpoint: CheckpointWithDiff) => {
    const truncateResult = await store.truncateBeforeMessage(activeSession.id, checkpoint.messageId)
    if (!truncateResult.success) {
      throw new Error(truncateResult.error ?? 'Failed to truncate session')
    }
    runtime.loop.invalidateRecordsCache()
    await reloadMessages()
  }, [store, activeSession.id, runtime.loop, reloadMessages])

  const restoreCodeToCheckpoint = useCallback(async (checkpoint: CheckpointWithDiff) => {
    const cpService = checkpointServiceRef.current
    const restoreResult = await cpService.restoreToCommit(checkpoint.commitHash)
    invalidateResolvedCwdCache(process.cwd())
    if (!restoreResult.success) {
      throw new Error(restoreResult.error ?? 'Failed to restore file state')
    }
  }, [])

  const summarizeRewindSegment = useCallback(async (checkpoint: CheckpointWithDiff, decision: RewindSummaryDecision) => {
    const loaded = await store.loadRecordsWithDiagnostics(activeSession.id)
    const rewrite = await buildRewindSummaryRewrite({
      records: loaded.records,
      targetMessageId: checkpoint.messageId,
      decision,
      summarize: (records) => runtime.loop.summarizeRecordsForRewind(records),
    })

    await store.replaceRecords(activeSession.id, rewrite.nextRecords)
    runtime.loop.invalidateRecordsCache()
    await reloadMessages()
  }, [store, activeSession.id, runtime.loop, reloadMessages])

  const handleRestoreSelect = useCallback(async (checkpoint: CheckpointWithDiff, decision: RestoreDecision) => {
    const messagePreview = formatRestoreMessagePreview(checkpoint.messageContent)

    if (decision === 'summarize-from-here') {
      await summarizeRewindSegment(checkpoint, decision)
      addSystemMessage(`Summarized from "${messagePreview}"`)
      setMode('idle')
      return
    }

    if (decision === 'summarize-up-to-here') {
      await summarizeRewindSegment(checkpoint, decision)
      addSystemMessage(`Summarized up to before "${messagePreview}"`)
      setMode('idle')
      return
    }

    if (decision === 'restore-conversation') {
      await restoreConversationToCheckpoint(checkpoint)
      addSystemMessage(`Conversation rewound to before "${messagePreview}"`)
      setMode('idle')
      return
    }

    if (decision === 'restore-code') {
      await restoreCodeToCheckpoint(checkpoint)
      addSystemMessage(`Code restored to before "${messagePreview}"`)
      setMode('idle')
      return
    }

    if (decision === 'restore-code-and-conversation') {
      await restoreConversationToCheckpoint(checkpoint)
      try {
        await restoreCodeToCheckpoint(checkpoint)
      } catch (error) {
        addSystemMessage(
          `Conversation rewound to before "${messagePreview}", but file state could not be reverted: ${error instanceof Error ? error.message : String(error)}`,
        )
        setMode('idle')
        return
      }
      addSystemMessage(`Code and conversation rewound to before "${messagePreview}"`)
      setMode('idle')
    }
  }, [addSystemMessage, restoreCodeToCheckpoint, restoreConversationToCheckpoint, summarizeRewindSegment])

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
    setText,
    setCursorPos,
  } = useKeyboardShortcuts({
    onSubmit: handleSubmit,
    onInterrupt: handleInterrupt,
    onExit: handleExit,
    onEnterRestoreMode: handleEnterRestoreMode,
    onCyclePermissionMode: cyclePermissionMode,
    onToggleTranscript: handleToggleTranscript,
    isStreaming,
    isRestoreMode: mode === 'restore',
    isPermissionVisible:
      permState.visible
      || exitPlan.state.visible
      || enterPlan.state.visible
      || askUserQuestion.state.visible
      || providerPanelOpen
      || modelPickerOpen
      || effortPickerOpen
      || screen === 'transcript',
  })

  restoreInputRef.current = (restoredText: string) => {
    setText(restoredText)
    setCursorPos(restoredText.length)
  }

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

  // Transcript mode: render into alternate screen buffer, replacing the
  // normal prompt view entirely.  The main screen is preserved by the
  // alt-screen escape sequences and restored when the component unmounts.
  if (screen === 'transcript') {
    return (
      <AlternateScreen>
        <TranscriptView
          store={store}
          sessionId={activeSession.id}
          onExit={() => setScreen('prompt')}
        />
      </AlternateScreen>
    )
  }

  return (
    <Box flexDirection="column" width="100%">
      <Static key={`${transcriptGeneration}`} items={staticItems}>
        {(item) => <StaticDisplayItem key={item.id} item={item} />}
      </Static>

      {/* Message list */}
      <MessageList
        items={liveItems}
        isStreaming={isStreaming}
        isOverlayActive={isOverlayActive}
        animationsEnabled={animationsEnabled}
      />

      {/* Live system items (e.g. duration summary) render in live area
          so they appear below thinking blocks, not above them. */}
      {liveSystemItems.map((item) => (
        <DisplayItem key={item.id} item={item} />
      ))}

      {/* Spinner during streaming */}
      {isStreaming && (
        <Spinner
          subText={spinnerSubText}
          mode={streamMode}
          taskSnapshot={taskSnapshot}
          spinnerColors={spinnerColors}
          active={showSpinner}
          responseLengthRef={responseLengthRef}
        />
      )}

      {showStoppedTaskList && (
        <Box paddingLeft={2}>
          <TaskListBlock
            snapshot={taskSnapshot}
            runningColor={spinnerColors.messageColor}
            animationsEnabled={animationsEnabled}
          />
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

      {effortPickerOpen && (
        <EffortPickerBar
          currentLevel={effortLevel as EffortLevel}
          maxEffort={runtime.modelConfig.maxEffort}
          onResolve={(result) => {
            setEffortPickerOpen(false)
            if (result.action === 'set') handleSetEffort(result.level)
          }}
        />
      )}

      {/* Input box (with horizontal lines) */}
      {mode !== 'restore' && !providerPanelOpen && !modelPickerOpen && !effortPickerOpen && (
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
            || effortPickerOpen
          }
        />
      )}

      {suggestionType !== 'none' && suggestions.length > 0 && (
        <CommandSuggestions suggestions={suggestions} selectedIndex={selectedSuggestion} />
      )}

      {/* Status line (below input, no border) */}
      <StatusLine
        model={runtime.modelConfig.model}
        usage={usage}
        pricing={runtime.modelConfig.pricing}
        permissionMode={permissionMode}
        hintMessage={hintMessage}
        effortLevel={effortLevel}
        contextWindow={providerConfig.get().agent.contextManagement?.contextWindow ?? 200_000}
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

function formatRestoreMessagePreview(content: string): string {
  const normalized = content.replace(/\s+/g, ' ').trim()
  if (normalized.length <= 50) return normalized
  return `${normalized.slice(0, 47)}...`
}

