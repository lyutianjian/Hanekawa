import { useState, useCallback, useRef, useEffect, useMemo, useSyncExternalStore } from 'react'
import { randomUUID } from 'node:crypto'
import { Box, Static, snapshotInkFrameForStdout, useStdout } from '../ink.js'
import type { InkFrameSnapshot } from '../ink.js'
import type { ActiveModelRuntime } from '../../harness/loop.js'
import type { SessionStore, SessionMeta } from '../../sessions/service.js'
import type { PermissionGate, PermissionMode } from '../../harness/permissions.js'
import type { ConfigService } from '../../config/service.js'
import type { SessionRecord } from '../../harness/types.js'
import type { CommandSubmitQueryOptions, CommandView, SetModelResult } from '../../commands/types.js'
import type { CommandRegistry } from '../../commands/registry.js'
import type { TUIDisplayItem, TUIStaticItem } from '../types.js'
import { useAgentLoop } from '../hooks/useAgentLoop.js'
import { recordsToDisplayItems } from '../transcript.js'
import { useKeyboardShortcuts } from '../hooks/useKeyboardShortcuts.js'
import { useCommands } from '../hooks/useCommands.js'
import { usePermission } from '../hooks/usePermission.js'
import type { PermissionPromptProxy } from '../hooks/usePermission.js'
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
import {
  formatRestoreMessagePreview,
  isSummarizeDecision,
  rewindPartialFailureMessage,
  rewindStepsFor,
  rewindSuccessMessage,
} from '../../runtime/rewindPresentation.js'
import { BackgroundTasksPanel } from './BackgroundTasksPanel.js'
import { SessionResumePicker } from './SessionResumePicker.js'
import { invalidateResolvedCwdCache } from '../../utils/paths.js'
import { applyPermissionModeTransition, nextPermissionMode } from '../../runtime/permissionMode.js'
import { ExitPlanModeDialog } from './ExitPlanModeDialog.js'
import { EnterPlanModeDialog } from './EnterPlanModeDialog.js'
import { AskUserQuestionDialog } from './AskUserQuestionDialog.js'
import { ProviderPanel } from './ProviderPanel.js'
import { ModelPickerDialog, type ModelPickerDecision } from './ModelPickerDialog.js'
import { EffortPickerBar } from './EffortPickerBar.js'
import { CommandViewPanel } from './CommandViewPanel.js'
import { useExitPlanPermission, type ExitPlanPromptProxy } from '../hooks/useExitPlanPermission.js'
import { useEnterPlanPermission, type EnterPlanPromptProxy } from '../hooks/useEnterPlanPermission.js'
import { useAskUserQuestionPermission, type AskUserQuestionProxy } from '../hooks/useAskUserQuestionPermission.js'
import type { AgentSession } from '../../runtime/index.js'
import type { RuntimeSlot } from '../../runtime/runtimeSlot.js'
import type { SessionController } from '../../runtime/sessionController.js'
import { canPumpQueue } from '../../runtime/queuePump.js'
import { buildModelPickerOptions } from '../../runtime/modelPicker.js'
import { buildRewindSummaryRewrite, type RewindSummaryDecision } from '../../runtime/rewindSummary.js'
import { activateModelKey, switchModel } from '../../runtime/modelSwitch.js'
import { switchToExistingSession, switchToNewSession } from '../../runtime/sessionSwitch.js'
import { buildRunOverrides } from '../../runtime/runOverrides.js'
import {
  openPlanFileInEditor,
  readCurrentPlanFile as readCurrentPlanFileFromRuntime,
} from '../../runtime/planFile.js'
import type { EffortLevel } from '../../config/effort.js'
import { getContextWindowForModel } from '../../prompts/budget.js'
import { MODEL_CONTEXT_WINDOW_DEFAULT } from '../../prompts/modelCapabilities.js'
import { shouldRenderStatusLine } from '../statusLineVisibility.js'
import { MessageQueue } from '../../runtime/messageQueue.js'
import type { BackgroundTaskRegistry } from '../../services/backgroundTasks/registry.js'
import { appendPromptHistory, loadPromptHistory, promptHistoryTexts } from '../../runtime/promptHistory.js'
import { summarizeDiagnosticsForTui } from '../../harness/diagnostics.js'
import {
  resolveRuntimeModelKeyAfterConfigChange,
  type ProviderConfigChangeScope,
} from '../../runtime/providerRuntime.js'

export type AppMode = 'idle' | 'running' | 'restore' | 'resume' | 'tasks' | 'exiting'

const ABORT_TIMEOUT_MS = 2000

/**
 * The runtime shape App consumes. Assembled by `src/runtime`; aliased here so
 * the component tree keeps a local name for it.
 */
export type AppRuntime = AgentSession

interface AppProps {
  /** Owns the live runtime and the effort level bound to it. */
  runtimeSlot: RuntimeSlot
  /** Owns the turn lifecycle; this component only renders its event stream. */
  sessionController: SessionController
  store: SessionStore
  session: SessionMeta
  /** This project's slash commands. See `ProjectRuntime.commands`. */
  commands: CommandRegistry
  availableModelKeys: string[]
  providerConfig: ConfigService
  createRuntime: (modelKey: string, session: SessionMeta, records?: readonly SessionRecord[]) => AppRuntime
  createActiveModelRuntime: (modelKey: string) => ActiveModelRuntime
  permissionGate: PermissionGate
  promptProxy: PermissionPromptProxy
  exitPlanProxy: ExitPlanPromptProxy
  enterPlanProxy: EnterPlanPromptProxy
  askUserQuestionProxy: AskUserQuestionProxy
  existingRecords: SessionRecord[]
  initialSystemMessages?: TUIDisplayItem[]
  initialQueuedPrompt?: string
  onBeforeExit?: () => Promise<void>
  onPermissionModeChange?: (mode: PermissionMode) => Promise<void> | void
  reloadAgentDefinitions?: () => Promise<number>
  reloadSkills?: () => Promise<number>
  onEffortLevelChange?: (level: string) => void
  backgroundTasks: BackgroundTaskRegistry
}

export function App({
  runtimeSlot,
  sessionController,
  store,
  session: initialSession,
  commands,
  availableModelKeys,
  providerConfig,
  createRuntime,
  createActiveModelRuntime,
  permissionGate,
  promptProxy,
  exitPlanProxy,
  enterPlanProxy,
  askUserQuestionProxy,
  existingRecords,
  initialSystemMessages,
  initialQueuedPrompt,
  onBeforeExit,
  onPermissionModeChange,
  reloadAgentDefinitions: reloadRuntimeAgentDefinitions,
  reloadSkills: reloadRuntimeSkills,
  onEffortLevelChange,
  backgroundTasks,
}: AppProps) {
  const [mode, setMode] = useState<AppMode>('idle')
  const [activeSession, setActiveSession] = useState<SessionMeta>(initialSession)
  // The records the transcript was last rebuilt from. useAgentLoop seeds its
  // initial transcript from these, so they only change when the view resets.
  const [sessionRecords, setSessionRecords] = useState<SessionRecord[]>(existingRecords)
  // The live record list. createRuntime folds it into taskState, so a mid-session
  // `/model` switch has to see everything appended since startup — but appending
  // must not re-render the transcript.
  const sessionRecordsRef = useRef<SessionRecord[]>([...existingRecords])
  const sessionRecordIdsRef = useRef<Set<string>>(new Set(existingRecords.map((record) => record.id)))
  const [promptHistory, setPromptHistory] = useState<string[]>([])
  const historyWarningShownRef = useRef(false)
  const [resumeSessions, setResumeSessions] = useState<SessionMeta[]>([])
  const [resumeLoading, setResumeLoading] = useState(false)
  const [resumeError, setResumeError] = useState<string | null>(null)
  const { session: runtime, effort: effortLevel } = useSyncExternalStore(
    runtimeSlot.subscribe,
    runtimeSlot.getSnapshot,
    runtimeSlot.getSnapshot,
  )
  const [checkpoints, setCheckpoints] = useState<CheckpointWithDiff[]>([])
  const [permissionMode, setPermissionModeState] = useState<PermissionMode>(() => permissionGate.getMode())
  const [modelKeys, setModelKeys] = useState<string[]>(availableModelKeys)
  const [providerPanelOpen, setProviderPanelOpen] = useState(false)
  const [modelPickerOpen, setModelPickerOpen] = useState(false)
  const [effortPickerOpen, setEffortPickerOpen] = useState(false)
  const [activeCommandView, setActiveCommandView] = useState<CommandView | null>(null)
  const abortTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const restoreInputRef = useRef<(text: string) => void>(() => {})
  const latestStaticItemCountRef = useRef(0)
  const transcriptStaticItemCountRef = useRef<number | null>(null)
  const promptFrameSnapshotRef = useRef<InkFrameSnapshot | undefined>(undefined)
  const [spinnerColors, setSpinnerColors] = useState(() => sampleSpinnerColors())
  const [queuePumpGeneration, setQueuePumpGeneration] = useState(0)
  const queuePumpRunningRef = useRef(false)
  const initialQueuedPromptRef = useRef(initialQueuedPrompt)
  const [messageQueue] = useState(() => new MessageQueue(
    initialSession.id,
    existingRecords,
    (sessionId, record) => store.appendRecord(sessionId, record),
  ))
  const queuedMessages = useSyncExternalStore(
    messageQueue.subscribe,
    messageQueue.getSnapshot,
    messageQueue.getSnapshot,
  )
  const [screen, setScreen] = useState<'prompt' | 'transcript'>('prompt')
  const [transcriptScrollOffsetRows, setTranscriptScrollOffsetRows] = useState(0)
  const { stdout } = useStdout()
  const subscribeBackgroundTasks = useCallback(
    (listener: () => void) => backgroundTasks.subscribe(listener),
    [backgroundTasks],
  )
  const getBackgroundTaskSnapshot = useCallback(
    () => backgroundTasks.getSnapshot(activeSession.id),
    [backgroundTasks, activeSession.id],
  )
  const backgroundTaskSnapshot = useSyncExternalStore(
    subscribeBackgroundTasks,
    getBackgroundTaskSnapshot,
    getBackgroundTaskSnapshot,
  )

  const { permState, respond, setActiveRequest, denyPending } = usePermission(promptProxy, { cwd: process.cwd() })
  const exitPlan = useExitPlanPermission(exitPlanProxy)
  const enterPlan = useEnterPlanPermission(enterPlanProxy)
  const askUserQuestion = useAskUserQuestionPermission(askUserQuestionProxy)

  useEffect(() => {
    setModelKeys(availableModelKeys)
  }, [availableModelKeys])

  useEffect(() => {
    let cancelled = false
    void loadPromptHistory(process.cwd()).then((entries) => {
      if (!cancelled) setPromptHistory(promptHistoryTexts(entries))
    }).catch(() => {
      // History is a convenience feature; a read failure must not block the TUI.
    })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    return () => {
      sessionController.dispose()
      runtimeSlot.dispose()
    }
  }, [runtimeSlot, sessionController])

  useEffect(() => {
    setPermissionModeState(permissionGate.getMode())
    return permissionGate.onModeChange((nextMode) => {
      setPermissionModeState(nextMode)
      void onPermissionModeChange?.(nextMode)
    })
  }, [permissionGate, onPermissionModeChange])

  const syncActiveModel = useCallback((activeModel: { modelKey?: string }) => {
    const nextModelKey = activeModel.modelKey
    if (!nextModelKey) return
    // The loop switched models on its own (fallback activation); it keeps
    // running on the same loop and plan-mode manager. Only the displayed
    // metadata changes, so read it from config rather than assembling a whole
    // runtime — that would construct a provider, re-register the tool set, and
    // install a plan-slug provider for a runtime nobody ever runs.
    const nextModelConfig = providerConfig.getModel(nextModelKey)
    if (!nextModelConfig) return
    runtimeSlot.patchModel(nextModelKey, nextModelConfig, nextModelConfig.provider)
  }, [providerConfig, runtimeSlot])

  const restoreInput = useCallback((text: string) => {
    restoreInputRef.current(text)
  }, [])

  /** Appends to the live record list. Records reach the UI over several paths, so dedupe by id. */
  const trackSessionRecord = useCallback((record: SessionRecord) => {
    if (sessionRecordIdsRef.current.has(record.id)) return
    sessionRecordIdsRef.current.add(record.id)
    sessionRecordsRef.current.push(record)
  }, [])

  /** Rebases the live record list after the session's records are replaced on disk. */
  const rebaseSessionRecords = useCallback((records: readonly SessionRecord[]) => {
    sessionRecordsRef.current = [...records]
    sessionRecordIdsRef.current = new Set(records.map((record) => record.id))
  }, [])

  /** `/clear` and resume also rebuild the transcript from these records. */
  const resetSessionRecords = useCallback((records: SessionRecord[]) => {
    rebaseSessionRecords(records)
    setSessionRecords(records)
  }, [rebaseSessionRecords])

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
    loadingStartTimeRef,
    totalPausedMsRef,
    pauseStartTimeRef,
    submit,
    interrupt,
    reloadMessages,
  } = useAgentLoop({
    controller: sessionController,
    existingRecords: sessionRecords,
    initialSystemMessages,
    pricing: runtime.modelConfig.pricing,
    onActiveModelChange: syncActiveModel,
    onRecordExternal: trackSessionRecord,
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
    || activeCommandView !== null
    || mode === 'restore'
    || mode === 'resume'
    || mode === 'tasks'
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

  /**
   * The host-agnostic half of a session switch, shared with `SessionHost`.
   *
   * `host` is only the two members the switch needs; the TUI has them as props
   * and never holds a `RuntimeHost`. Everything the switch does *not* own — the
   * message queue, the transcript, `activeSession` — stays in the two callbacks
   * below, which is the whole boundary between shell and runtime here.
   */
  const sessionSwitchDeps = useMemo(() => ({
    host: { store, createRuntime },
    runtimeSlot,
    controller: sessionController,
    backgroundTasks,
  }), [store, createRuntime, runtimeSlot, sessionController, backgroundTasks])

  const clearConversation = useCallback(async () => {
    const result = await switchToNewSession({
      ...sessionSwitchDeps,
      // Before the new runtime goes live, never after: see `beforeApply`.
      beforeApply: (next) => messageQueue.migrateTo(next.id, []),
    }, { previousSessionId: activeSession.id })
    setActiveSession(result.session)
    resetSessionRecords([])
    setCheckpoints([])
    resetTranscript([])
  }, [sessionSwitchDeps, messageQueue, activeSession.id, resetSessionRecords, resetTranscript])

  const buildRunOverridesForOptions = useCallback((options?: CommandSubmitQueryOptions) => (
    buildRunOverrides({ config: providerConfig, runtimeSlot, createActiveModelRuntime }, options)
  ), [createActiveModelRuntime, providerConfig, runtimeSlot])

  const submitPlainInput = useCallback(async (text: string, options?: CommandSubmitQueryOptions) => {
    setSpinnerColors(sampleSpinnerColors())
    setMode('running')
    try {
      await submit(text, buildRunOverridesForOptions(options))
    } finally {
      setMode('idle')
    }
  }, [submit, buildRunOverridesForOptions])

  const runShellCommand = useCallback(async (command: string) => {
    const result = await runtimeSlot.current.loop.runTool({
      id: randomUUID(),
      name: 'Bash',
      input: { command },
    })
    return {
      ok: result.ok,
      content: result.content,
      ...(result.errorCode ? { errorCode: result.errorCode } : {}),
    }
  }, [runtimeSlot])

  useEffect(() => {
    const prompt = initialQueuedPromptRef.current
    if (!prompt) return
    initialQueuedPromptRef.current = undefined
    void messageQueue.enqueue(prompt).catch((error) => {
      addSystemMessage(`Failed to queue prompt: ${error instanceof Error ? error.message : String(error)}`)
    })
  }, [messageQueue, addSystemMessage])

  /** Shared with the host-side CommandContext; see `runtime/modelSwitch.ts`. */
  const modelSwitchDeps = useMemo(() => ({
    config: providerConfig,
    runtimeSlot,
    availableModelKeys: modelKeys,
    createRuntime,
    getSession: () => activeSession,
    getRecords: () => sessionRecordsRef.current,
  }), [providerConfig, runtimeSlot, modelKeys, createRuntime, activeSession])

  const activateModel = useCallback((modelKey: string): SetModelResult => (
    activateModelKey(modelSwitchDeps, modelKey)
  ), [modelSwitchDeps])

  const switchToModel = useCallback((input: string): SetModelResult => (
    switchModel(modelSwitchDeps, input)
  ), [modelSwitchDeps])

  const refreshRuntimeAfterProviderConfigChange = useCallback((scope: ProviderConfigChangeScope) => {
    setModelKeys(Object.keys(providerConfig.get().models))

    const currentRuntime = runtimeSlot.current
    const modelKey = resolveRuntimeModelKeyAfterConfigChange(
      providerConfig,
      currentRuntime.modelKey,
      scope,
    )
    if (!modelKey) {
      throw new Error('No model is available after the provider configuration change.')
    }

    const nextRuntime = createRuntime(modelKey, activeSession, sessionRecordsRef.current)
    currentRuntime.loop.clearCachedSections()
    runtimeSlot.replace(nextRuntime)
    runtimeSlot.reapplyEffort()
  }, [providerConfig, createRuntime, activeSession, runtimeSlot])

  const handleSetEffort = useCallback((level: string) => {
    const clampedLevel = runtimeSlot.setEffort(level)
    onEffortLevelChange?.(clampedLevel)
  }, [onEffortLevelChange, runtimeSlot])

  const modelPickerOptions = useMemo(
    () => buildModelPickerOptions(providerConfig, runtime.modelKey, modelKeys),
    [providerConfig, runtime.modelKey, modelKeys],
  )

  const handleModelPickerResolve = useCallback(async (decision: ModelPickerDecision | { action: 'cancel' }) => {
    setModelPickerOpen(false)
    if (decision.action === 'cancel') return

    const modelKey = decision.option.modelKey
    if (!modelKey) {
      addSystemMessage(`Model unavailable: ${decision.option.label}`)
      return
    }

    if (decision.action === 'set-default') {
      try {
        providerConfig.setDefaultModel(decision.option.key)
        await providerConfig.save()
        setModelKeys(Object.keys(providerConfig.get().models))
      } catch (error) {
        addSystemMessage(`Failed to update default model: ${error instanceof Error ? error.message : String(error)}`)
        return
      }
    }

    const result = activateModel(modelKey)
    if (!result.ok) {
      addSystemMessage(result.message)
      return
    }

    const message = `Model set to: ${result.model.key} (${result.model.providerName}: ${result.model.model})`
    addSystemMessage(decision.action === 'set-default'
      ? `${message}\nDefault model updated.`
      : message)
  }, [providerConfig, activateModel, addSystemMessage])

  const reloadAgentDefinitions = useCallback(async (): Promise<number> => {
    if (!reloadRuntimeAgentDefinitions) {
      throw new Error('Agent definition reload is not available in this runtime.')
    }
    const count = await reloadRuntimeAgentDefinitions()
    runtime.loop.clearCachedSections()
    const nextRuntime = createRuntime(runtime.modelKey, activeSession, sessionRecordsRef.current)
    runtimeSlot.replace(nextRuntime)
    return count
  }, [reloadRuntimeAgentDefinitions, runtime.loop, runtime.modelKey, createRuntime, activeSession, runtimeSlot])

  const reloadSkills = useCallback(async (): Promise<number> => {
    if (!reloadRuntimeSkills) {
      throw new Error('Skill reload is not available in this runtime.')
    }
    const count = await reloadRuntimeSkills()
    // Same shape as the agent-definition reload: skills feed the system prompt
    // through `createRuntime`, so the live runtime has to be rebuilt to see them.
    runtime.loop.clearCachedSections()
    runtimeSlot.replace(createRuntime(runtime.modelKey, activeSession, sessionRecordsRef.current))
    return count
  }, [reloadRuntimeSkills, runtime.loop, runtime.modelKey, createRuntime, activeSession, runtimeSlot])

  const cyclePermissionMode = useCallback((direction: 1 | -1) => {
    setPermissionModeState((currentMode) => {
      const nextMode = nextPermissionMode(currentMode, direction)
      return applyPermissionModeTransition(permissionGate, runtimeSlot.current.planModeManager, nextMode)
    })
  }, [permissionGate, runtimeSlot])

  useEffect(() => {
    runtime.planModeManager.setUiDeps({
      emitChatMessage: async (content) => addSystemMessage(content),
      openEnterPrompt: enterPlanProxy.open,
      openExitDialog: exitPlanProxy.open,
    })
  }, [runtime.planModeManager, addSystemMessage, enterPlanProxy, exitPlanProxy])

  const planFileDeps = useMemo(
    () => ({ getPlanModeManager: () => runtimeSlot.current.planModeManager }),
    [runtimeSlot],
  )

  const readCurrentPlanFile = useCallback(async () => (
    readCurrentPlanFileFromRuntime(planFileDeps)
  ), [planFileDeps])

  const openCurrentPlanFile = useCallback(async (): Promise<{ message: string }> => (
    openPlanFileInEditor(planFileDeps)
  ), [planFileDeps])

  const closePickerSurfaces = useCallback(() => {
    setProviderPanelOpen(false)
    setModelPickerOpen(false)
    setEffortPickerOpen(false)
    setActiveCommandView(null)
  }, [])

  const openBackgroundTasks = useCallback(() => {
    closePickerSurfaces()
    setMode('tasks')
  }, [closePickerSurfaces])
  const closeBackgroundTasks = useCallback(() => setMode('idle'), [])

  // Defined here rather than next to the other restore handlers below, because
  // `useCommands` closes over it for `/rewind` and a `const` declared after that
  // call would be a TDZ error. Same placement rule as `openBackgroundTasks` and
  // `openResumePicker` above.
  const handleEnterRestoreMode = useCallback(async () => {
    try {
      const cpService = sessionController.getCheckpointService()
      const cpList = await cpService.getCheckpointsWithDiffs()
      setCheckpoints(cpList)
      setMode('restore')
    } catch {
      // If fetching checkpoints fails, just stay in idle
      setCheckpoints([])
      setMode('restore')
    }
  }, [sessionController])

  const openResumePicker = useCallback(() => {
    closePickerSurfaces()
    setResumeLoading(true)
    setResumeError(null)
    setMode('resume')
    void store.list().then((sessions) => {
      setResumeSessions(sessions.some((session) => session.id === activeSession.id)
        ? sessions
        : [activeSession, ...sessions])
    }).catch((error) => {
      setResumeSessions([])
      setResumeError(error instanceof Error ? error.message : String(error))
    }).finally(() => setResumeLoading(false))
  }, [activeSession, closePickerSurfaces, store])

  const closeResumePicker = useCallback(() => {
    setResumeError(null)
    setMode('idle')
  }, [])

  const resumeSession = useCallback(async (target: SessionMeta) => {
    if (target.id === activeSession.id) {
      closeResumePicker()
      return
    }

    // Throws for a session that is gone; `SessionResumePicker` catches what
    // `onSelect` rejects with and shows it in place.
    const result = await switchToExistingSession({
      ...sessionSwitchDeps,
      beforeApply: (next, records) => messageQueue.reset(next.id, records),
    }, target.id)

    // Only the diagnostics: the host pairs these with its MCP status, but a
    // resume in the terminal has never reported connection state.
    const diagnosticSummary = summarizeDiagnosticsForTui(result.diagnostics)
    const transcriptItems = recordsToDisplayItems(result.records)
    if (diagnosticSummary) {
      transcriptItems.unshift({
        kind: 'system',
        id: randomUUID(),
        content: diagnosticSummary,
        createdAt: new Date().toISOString(),
      })
    }

    resetSessionRecords(result.records)
    setActiveSession(result.session)
    setCheckpoints([])
    resetTranscript(transcriptItems)
    setMode('idle')
  }, [activeSession.id, closeResumePicker, sessionSwitchDeps, messageQueue, resetTranscript, resetSessionRecords])

  const { dispatch } = useCommands({
    store,
    session: activeSession,
    commands,
    cwd: process.cwd(),
    model: {
      key: runtime.modelKey,
      model: runtime.modelConfig.model,
      providerName: runtime.providerName,
    },
    setModel: switchToModel,
    pricing: runtime.modelConfig.pricing,
    usage,
    addSystemMessage,
    openCommandView: (view) => {
      setProviderPanelOpen(false)
      setModelPickerOpen(false)
      setEffortPickerOpen(false)
      setMode('idle')
      setActiveCommandView(view)
    },
    clearMessages: clearConversation,
    clearCachedSections: () => runtime.loop.clearCachedSections(),
    invalidateRecordsCache: () => runtime.loop.invalidateRecordsCache(),
    reloadAgentDefinitions,
    reloadSkills,
    getPermissionMode: () => permissionGate.getMode(),
    enterPlanMode: () => {
      const mode = applyPermissionModeTransition(permissionGate, runtimeSlot.current.planModeManager, 'plan')
      setPermissionModeState(mode)
    },
    readPlanFile: readCurrentPlanFile,
    openPlanFile: openCurrentPlanFile,
    submitQuery: submitPlainInput,
    runShellCommand,
    openModelPicker: () => {
      closePickerSurfaces()
      setModelPickerOpen(true)
    },
    openEffortPicker: () => {
      closePickerSurfaces()
      setEffortPickerOpen(true)
    },
    openProviderPanel: () => {
      closePickerSurfaces()
      setProviderPanelOpen(true)
    },
    openBackgroundTasks,
    openResumePicker,
    openRewindPanel: () => { void handleEnterRestoreMode() },
    getEffort: () => effortLevel,
    setEffort: handleSetEffort,
  })

  const executeQueuedInput = useCallback(async (text: string) => {
    if (text.startsWith('/')) {
      await dispatch(text)
      return
    }
    await submitPlainInput(text)
  }, [dispatch, submitPlainInput])

  const handleSubmit = useCallback(async (text: string): Promise<boolean> => {
    try {
      await messageQueue.enqueue(text)
      void appendPromptHistory(text, process.cwd()).then((entry) => {
        if (!entry) return
        setPromptHistory((current) => [...current, entry.text].slice(-1000))
      }).catch((error) => {
        if (historyWarningShownRef.current) return
        historyWarningShownRef.current = true
        addSystemMessage(`Input history could not be saved: ${error instanceof Error ? error.message : String(error)}`)
      })
      return true
    } catch (error) {
      addSystemMessage(`Failed to queue message: ${error instanceof Error ? error.message : String(error)}`)
      return false
    }
  }, [addSystemMessage, messageQueue])

  useEffect(() => {
    // `mode` folds two unrelated ideas together: 'running' means a turn is in
    // flight, everything else non-idle means a surface is holding the screen.
    // The headless policy keeps them apart so a desktop shell can substitute
    // "a permission request is pending" for the second one.
    if (!canPumpQueue({
      pending: queuedMessages.length,
      running: queuePumpRunningRef.current,
      turnActive: isStreaming || mode === 'running',
      uiBlocked: isOverlayActive || mode !== 'idle',
    })) return

    queuePumpRunningRef.current = true
    void (async () => {
      try {
        const next = await messageQueue.dequeue()
        if (next) await executeQueuedInput(next.content)
      } catch (error) {
        addSystemMessage(`Failed to process queued message: ${error instanceof Error ? error.message : String(error)}`)
      } finally {
        queuePumpRunningRef.current = false
        setQueuePumpGeneration((value) => value + 1)
      }
    })()
  }, [queuedMessages, isStreaming, mode, isOverlayActive, executeQueuedInput, addSystemMessage, messageQueue, queuePumpGeneration])

  const handleToggleTranscript = useCallback(() => {
    if (screen === 'transcript') {
      transcriptStaticItemCountRef.current = null
      setScreen('prompt')
      return
    }

    promptFrameSnapshotRef.current = snapshotInkFrameForStdout(stdout)
    transcriptStaticItemCountRef.current = latestStaticItemCountRef.current
    setTranscriptScrollOffsetRows(0)
    setScreen('transcript')
  }, [screen, stdout])

  const handleCloseTranscript = useCallback(() => {
    transcriptStaticItemCountRef.current = null
    setScreen('prompt')
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

  const handleClearQueue = useCallback(() => {
    void messageQueue.clear().then(() => {
      addSystemMessage('Queued messages cleared.')
    }).catch((error) => {
      addSystemMessage(`Failed to clear queued messages: ${error instanceof Error ? error.message : String(error)}`)
    })
  }, [addSystemMessage, messageQueue])

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
      store.discardDraft(activeSession.id)
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
  }, [activeSession.id, isStreaming, interrupt, onBeforeExit, store])

  const handleRestoreCancel = useCallback(() => {
    setMode('idle')
  }, [])

  const restoreConversationToCheckpoint = useCallback(async (checkpoint: CheckpointWithDiff) => {
    const truncateResult = await store.truncateBeforeMessage(activeSession.id, checkpoint.messageId)
    if (!truncateResult.success) {
      throw new Error(truncateResult.error ?? 'Failed to truncate session')
    }
    runtime.loop.invalidateRecordsCache()
    const records = await reloadMessages()
    rebaseSessionRecords(records)
    await messageQueue.hydrate(records)
  }, [store, activeSession.id, runtime.loop, reloadMessages, rebaseSessionRecords, messageQueue])

  const restoreCodeToCheckpoint = useCallback(async (checkpoint: CheckpointWithDiff) => {
    const cpService = sessionController.getCheckpointService()
    const restoreResult = await cpService.restoreToCommit(checkpoint.commitHash)
    invalidateResolvedCwdCache(process.cwd())
    if (!restoreResult.success) {
      throw new Error(restoreResult.error ?? 'Failed to restore file state')
    }
  }, [sessionController])

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
    const records = await reloadMessages()
    rebaseSessionRecords(records)
    await messageQueue.hydrate(records)
  }, [store, activeSession.id, runtime.loop, reloadMessages, rebaseSessionRecords, messageQueue])

  /**
   * The decision → side effects mapping is `rewindStepsFor`, shared with the
   * desktop panel, and so are the five outcome strings. Neither shell gets to
   * decide that `restore-code-and-conversation` truncates before it reverts
   * files: that ordering is the whole reason the partial-failure message exists.
   */
  const handleRestoreSelect = useCallback(async (checkpoint: CheckpointWithDiff, decision: RestoreDecision) => {
    const messagePreview = formatRestoreMessagePreview(checkpoint.messageContent)
    const steps = rewindStepsFor(decision)
    if (steps.length === 0) return

    let truncated = false
    for (const step of steps) {
      if (step === 'summarize' && isSummarizeDecision(decision)) {
        await summarizeRewindSegment(checkpoint, decision)
        continue
      }
      if (step === 'truncate') {
        await restoreConversationToCheckpoint(checkpoint)
        truncated = true
        continue
      }
      try {
        await restoreCodeToCheckpoint(checkpoint)
      } catch (error) {
        // The conversation is already cut; saying "rewind failed" would be a lie.
        if (!truncated) throw error
        addSystemMessage(rewindPartialFailureMessage(
          messagePreview,
          error instanceof Error ? error.message : String(error),
        ))
        setMode('idle')
        return
      }
    }

    addSystemMessage(rewindSuccessMessage(decision, messagePreview))
    setMode('idle')
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
    onClearQueue: handleClearQueue,
    onExit: handleExit,
    onEnterRestoreMode: handleEnterRestoreMode,
    onCyclePermissionMode: cyclePermissionMode,
    onToggleTranscript: handleToggleTranscript,
    commands,
    history: promptHistory,
    isStreaming,
    hasQueuedMessages: queuedMessages.length > 0,
    isRestoreMode:
      mode === 'restore'
      || mode === 'resume'
      || mode === 'tasks'
      || providerPanelOpen
      || modelPickerOpen
      || effortPickerOpen
      || activeCommandView !== null,
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
  latestStaticItemCountRef.current = staticItems.length

  const frozenStaticItemCount = screen === 'transcript'
    ? transcriptStaticItemCountRef.current
    : null
  const staticItemsForInk = frozenStaticItemCount === null
    ? staticItems
    : staticItems.slice(0, frozenStaticItemCount)
  const transcriptItems = useMemo(
    () => [...staticTranscriptItems, ...liveItems, ...liveSystemItems],
    [staticTranscriptItems, liveItems, liveSystemItems],
  )

  return (
    <Box flexDirection="column" width="100%">
      <Static key={`${transcriptGeneration}`} items={staticItemsForInk}>
        {(item) => <StaticDisplayItem key={item.id} item={item} />}
      </Static>

      {screen === 'transcript' ? (
        <AlternateScreen promptFrameSnapshot={promptFrameSnapshotRef.current}>
          <TranscriptView
            items={transcriptItems}
            scrollOffsetRows={transcriptScrollOffsetRows}
            onScrollOffsetRowsChange={setTranscriptScrollOffsetRows}
            onExit={handleCloseTranscript}
          />
        </AlternateScreen>
      ) : (
        <>
          {/* Message list */}
          <MessageList
            items={liveItems}
            queuedMessages={queuedMessages}
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
              loadingStartTimeRef={loadingStartTimeRef}
              totalPausedMsRef={totalPausedMsRef}
              pauseStartTimeRef={pauseStartTimeRef}
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

          {mode === 'tasks' && (
            <BackgroundTasksPanel
              tasks={backgroundTaskSnapshot}
              peekOutput={(taskId) => backgroundTasks.peekOutput(activeSession.id, taskId)}
              onClose={closeBackgroundTasks}
            />
          )}

          {mode === 'resume' && (
            <SessionResumePicker
              sessions={resumeSessions}
              currentSessionId={activeSession.id}
              loading={resumeLoading}
              error={resumeError}
              onSelect={resumeSession}
              onCancel={closeResumePicker}
            />
          )}

          {providerPanelOpen && (
            <ProviderPanel
              config={providerConfig}
              onChange={refreshRuntimeAfterProviderConfigChange}
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

          {activeCommandView && (
            <CommandViewPanel view={activeCommandView} onClose={() => setActiveCommandView(null)} />
          )}

          {/* Input box (with horizontal lines) */}
          {mode !== 'restore' && mode !== 'tasks' && mode !== 'resume' && !providerPanelOpen && !modelPickerOpen && !effortPickerOpen && !activeCommandView && (
            <InputBox
              text={text}
              cursorPos={cursorPos}
              disabled={
                permState.visible
                || exitPlan.state.visible
                || enterPlan.state.visible
                || askUserQuestion.state.visible
                || providerPanelOpen
                || modelPickerOpen
                || effortPickerOpen
                || activeCommandView !== null
              }
              isStreaming={isStreaming}
            />
          )}

          {!isOverlayActive && suggestionType !== 'none' && suggestions.length > 0 && (
            <CommandSuggestions suggestions={suggestions} selectedIndex={selectedSuggestion} />
          )}
        </>
      )}

      {/* Status line (below input, no border) */}
      {shouldRenderStatusLine(screen, mode) && !providerPanelOpen && !modelPickerOpen && !effortPickerOpen && !activeCommandView && (
        <StatusLine
          model={runtime.modelConfig.model}
          usage={usage}
          permissionMode={permissionMode}
          hintMessage={hintMessage}
          effortLevel={effortLevel}
          contextWindow={getContextWindowForModel(
            {
              ...providerConfig.get().agent.contextManagement,
              contextWindow: runtime.modelConfig.contextWindow ?? MODEL_CONTEXT_WINDOW_DEFAULT,
            },
          )}
          backgroundTaskCount={backgroundTaskSnapshot.filter((task) => task.status === 'running').length}
        />
      )}
    </Box>
  )
}

