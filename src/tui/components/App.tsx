import { useState, useCallback, useRef, useEffect, useMemo, useSyncExternalStore } from 'react'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { Box, Static, snapshotInkFrameForStdout, useStdout } from '../ink.js'
import type { InkFrameSnapshot } from '../ink.js'
import type { AgentLoop, ActiveModelRuntime, AgentRunOverrides } from '../../harness/loop.js'
import type { SessionStore, SessionMeta } from '../../sessions/service.js'
import type { PermissionGate, PermissionMode } from '../../harness/permissions.js'
import type { PlanModeManager } from '../../harness/planModeManager.js'
import type { ConfigService, ModelConfig } from '../../config/service.js'
import { resolveTier, type Tier } from '../../config/routing.js'
import type { SessionRecord } from '../../harness/types.js'
import type { CommandSubmitQueryOptions, CommandView, SetModelResult } from '../../commands/types.js'
import type { TUIDisplayItem, TUIStaticItem } from '../types.js'
import { useAgentLoop } from '../hooks/useAgentLoop.js'
import { recordsToDisplayItems } from '../transcript.js'
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
import { BackgroundTasksPanel } from './BackgroundTasksPanel.js'
import { SessionResumePicker } from './SessionResumePicker.js'
import { invalidateResolvedCwdCache } from '../../utils/paths.js'
import { readPlan } from '../../utils/plans.js'
import { applyPermissionModeTransition, nextPermissionMode } from '../permissionMode.js'
import { ExitPlanModeDialog } from './ExitPlanModeDialog.js'
import { EnterPlanModeDialog } from './EnterPlanModeDialog.js'
import { AskUserQuestionDialog } from './AskUserQuestionDialog.js'
import { ProviderPanel } from './ProviderPanel.js'
import { ModelPickerDialog, type ModelPickerDecision, type ModelPickerOption } from './ModelPickerDialog.js'
import { EffortPickerBar } from './EffortPickerBar.js'
import { CommandViewPanel } from './CommandViewPanel.js'
import { useExitPlanPermission, type ExitPlanPromptProxy } from '../hooks/useExitPlanPermission.js'
import { useEnterPlanPermission, type EnterPlanPromptProxy } from '../hooks/useEnterPlanPermission.js'
import { useAskUserQuestionPermission, type AskUserQuestionProxy } from '../hooks/useAskUserQuestionPermission.js'
import { buildRewindSummaryRewrite, type RewindSummaryDecision } from '../rewindSummary.js'
import { clampEffort, type EffortValue, type EffortLevel } from '../../config/effort.js'
import { getContextWindowForModel } from '../../prompts/budget.js'
import { MODEL_CONTEXT_WINDOW_DEFAULT } from '../../prompts/modelCapabilities.js'
import { shouldRenderStatusLine } from '../statusLineVisibility.js'
import {
  clearMessageQueue,
  dequeueMessage,
  enqueueMessage,
  getMessageQueueSnapshot,
  hydrateMessageQueue,
  initializeMessageQueue,
  migrateMessageQueue,
  subscribeMessageQueue,
} from '../messageQueue.js'
import type { BackgroundTaskRegistry } from '../../services/backgroundTasks/registry.js'
import { appendPromptHistory, loadPromptHistory, promptHistoryTexts } from '../promptHistory.js'
import { summarizeDiagnosticsForTui } from '../../harness/diagnostics.js'
import {
  resolveRuntimeModelKeyAfterConfigChange,
  type ProviderConfigChangeScope,
} from '../providerRuntime.js'

export type AppMode = 'idle' | 'running' | 'restore' | 'resume' | 'tasks' | 'exiting'

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
  createRuntime: (modelKey: string, session: SessionMeta, records?: readonly SessionRecord[]) => AppRuntime
  createActiveModelRuntime: (modelKey: string) => ActiveModelRuntime
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
  backgroundTasks: BackgroundTaskRegistry
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
  createActiveModelRuntime,
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
  backgroundTasks,
}: AppProps) {
  const [mode, setMode] = useState<AppMode>('idle')
  const [activeSession, setActiveSession] = useState<SessionMeta>(initialSession)
  const [sessionRecords, setSessionRecords] = useState<SessionRecord[]>(existingRecords)
  const [promptHistory, setPromptHistory] = useState<string[]>([])
  const historyWarningShownRef = useRef(false)
  const [resumeSessions, setResumeSessions] = useState<SessionMeta[]>([])
  const [resumeLoading, setResumeLoading] = useState(false)
  const [resumeError, setResumeError] = useState<string | null>(null)
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
  const [activeCommandView, setActiveCommandView] = useState<CommandView | null>(null)
  const [effortLevel, setEffortLevel] = useState<string>(initialEffortLevel ?? 'high')
  const abortTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const restoreInputRef = useRef<(text: string) => void>(() => {})
  const latestStaticItemCountRef = useRef(0)
  const transcriptStaticItemCountRef = useRef<number | null>(null)
  const promptFrameSnapshotRef = useRef<InkFrameSnapshot | undefined>(undefined)
  const [spinnerColors, setSpinnerColors] = useState(() => sampleSpinnerColors())
  const checkpointServiceRef = useRef<CheckpointService>(
    new CheckpointService(process.cwd(), initialSession.id),
  )
  const [queuePumpGeneration, setQueuePumpGeneration] = useState(0)
  const queuePumpRunningRef = useRef(false)
  const initialQueuedPromptRef = useRef(initialQueuedPrompt)
  const [messageQueueInitialized] = useState(() => {
    initializeMessageQueue(initialSession.id, existingRecords, (sessionId, record) => store.appendRecord(sessionId, record))
    return true
  })
  const queuedMessages = useSyncExternalStore(
    subscribeMessageQueue,
    getMessageQueueSnapshot,
    getMessageQueueSnapshot,
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
    const nextRuntime = createRuntime(activeModel.modelKey, activeSession, sessionRecords)
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
  }, [createRuntime, activeSession, sessionRecords, runtime.modelKey])

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
    existingRecords: sessionRecords,
    initialSystemMessages,
    pricing: runtime.modelConfig.pricing,
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

  const clearConversation = useCallback(async () => {
    runtime.loop.clearCachedSections()
    await backgroundTasks.stopAll(activeSession.id, 'Session cleared')
    store.discardDraft(activeSession.id)
    const nextSession = store.createDraft()
    await migrateMessageQueue(nextSession.id, [])
    const nextRuntime = createRuntime(runtime.modelKey, nextSession, [])
    checkpointServiceRef.current = new CheckpointService(process.cwd(), nextSession.id)
    setActiveSession(nextSession)
    setSessionRecords([])
    replaceRuntime(nextRuntime)
    setCheckpoints([])
    resetTranscript([])
  }, [store, createRuntime, runtime.modelKey, runtime.loop, replaceRuntime, resetTranscript, backgroundTasks, activeSession.id])

  const buildRunOverrides = useCallback((options?: CommandSubmitQueryOptions): AgentRunOverrides | undefined => {
    if (!options) return undefined
    let modelOverride: ActiveModelRuntime | undefined
    let effortOverride = options.effort

    if (options.model) {
      const modelKey = resolveModelInput(options.model, runtimeRef.current.modelKey)
      if (!modelKey) {
        throw new Error(`Unknown model or tier for skill command: ${options.model}`)
      }
      const modelConfig = providerConfig.getModel(modelKey)
      if (!modelConfig) {
        throw new Error(`Unknown model for skill command: ${options.model}`)
      }
      modelOverride = createActiveModelRuntime(modelKey)
      if (effortOverride) {
        const clamped = clampEffort(effortOverride, modelConfig.maxEffort)
        effortOverride = typeof clamped === 'string' ? clamped : undefined
      }
    } else if (effortOverride) {
      const clamped = clampEffort(effortOverride, runtimeRef.current.modelConfig.maxEffort)
      effortOverride = typeof clamped === 'string' ? clamped : undefined
    }

    return {
      ...(options.allowedTools ? { allowedTools: options.allowedTools } : {}),
      ...(modelOverride ? { model: modelOverride } : {}),
      ...(effortOverride ? { effort: effortOverride } : {}),
      ...(options.hooks ? { hooks: options.hooks } : {}),
      ...(options.skillName ? { skillName: options.skillName } : {}),
      ...(options.skillArgs !== undefined ? { skillArgs: options.skillArgs } : {}),
      ...(options.displayInput !== undefined ? { displayInput: options.displayInput } : {}),
    }
  }, [createActiveModelRuntime, providerConfig, resolveModelInput])

  const submitPlainInput = useCallback(async (text: string, options?: CommandSubmitQueryOptions) => {
    setSpinnerColors(sampleSpinnerColors())
    setMode('running')
    try {
      await submit(text, buildRunOverrides(options))
    } finally {
      setMode('idle')
    }
  }, [submit, buildRunOverrides])

  const runShellCommand = useCallback(async (command: string) => {
    const result = await runtimeRef.current.loop.runTool({
      id: randomUUID(),
      name: 'Bash',
      input: { command },
    })
    return {
      ok: result.ok,
      content: result.content,
      ...(result.errorCode ? { errorCode: result.errorCode } : {}),
    }
  }, [])

  useEffect(() => {
    const prompt = initialQueuedPromptRef.current
    if (!messageQueueInitialized || !prompt) return
    initialQueuedPromptRef.current = undefined
    void enqueueMessage(prompt).catch((error) => {
      addSystemMessage(`Failed to queue prompt: ${error instanceof Error ? error.message : String(error)}`)
    })
  }, [messageQueueInitialized, addSystemMessage])

  const activateModelKey = useCallback((modelKey: string): SetModelResult => {
    if (!modelKeys.includes(modelKey)) {
      return {
        ok: false,
        message: `Unknown model: ${modelKey}`,
        availableModels: [...modelKeys, 'fast', 'balanced', 'powerful'],
      }
    }

    try {
      const nextRuntime = createRuntime(modelKey, activeSession, sessionRecords)
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
  }, [modelKeys, createRuntime, activeSession, sessionRecords, replaceRuntime])

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

  const refreshRuntimeAfterProviderConfigChange = useCallback((scope: ProviderConfigChangeScope) => {
    setModelKeys(Object.keys(providerConfig.get().models))

    const currentRuntime = runtimeRef.current
    const modelKey = resolveRuntimeModelKeyAfterConfigChange(
      providerConfig,
      currentRuntime.modelKey,
      scope,
    )
    if (!modelKey) {
      throw new Error('No model is available after the provider configuration change.')
    }

    const nextRuntime = createRuntime(modelKey, activeSession, sessionRecords)
    currentRuntime.loop.clearCachedSections()
    replaceRuntime(nextRuntime)

    const clamped = clampEffort(effortLevel as EffortValue, nextRuntime.modelConfig.maxEffort)
    const clampedLevel = typeof clamped === 'number' ? effortLevel : clamped
    if (clampedLevel !== effortLevel) setEffortLevel(clampedLevel)
    nextRuntime.loop.setEffort(typeof clamped === 'string' ? clamped as EffortLevel : undefined)
  }, [providerConfig, createRuntime, activeSession, sessionRecords, replaceRuntime, effortLevel])

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
    const nextRuntime = createRuntime(runtime.modelKey, activeSession, sessionRecords)
    replaceRuntime(nextRuntime)
    return count
  }, [reloadRuntimeAgentDefinitions, runtime.loop, runtime.modelKey, createRuntime, activeSession, sessionRecords, replaceRuntime])

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
        await enqueueMessage(content)
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

    const loaded = await store.loadRecordsWithDiagnostics(target.id)
    const alreadyRegistered = backgroundTasks.getSnapshot(target.id).length > 0
    const orphanedAgentIds = new Set(alreadyRegistered
      ? []
      : await backgroundTasks.restoreSession(target.id, loaded.records))
    if (orphanedAgentIds.size > 0) {
      const latestTasks = new Map<string, Extract<SessionRecord, { type: 'subagent_task' }>>()
      for (const record of loaded.records) {
        if (record.type === 'subagent_task') latestTasks.set(record.agentId, record)
      }
      for (const agentId of orphanedAgentIds) {
        const previous = latestTasks.get(agentId)
        if (!previous || previous.status !== 'running') continue
        const interrupted: Extract<SessionRecord, { type: 'subagent_task' }> = {
          ...previous,
          id: randomUUID(),
          status: 'interrupted',
          error: 'Background agent was not present when the session resumed',
          createdAt: new Date().toISOString(),
        }
        await store.appendRecord(target.id, interrupted)
        loaded.records.push(interrupted)
      }
    }

    const nextRuntime = createRuntime(runtimeRef.current.modelKey, target, loaded.records)
    const diagnosticSummary = summarizeDiagnosticsForTui(loaded.diagnostics)
    const transcriptItems = recordsToDisplayItems(loaded.records)
    if (diagnosticSummary) {
      transcriptItems.unshift({
        kind: 'system',
        id: randomUUID(),
        content: diagnosticSummary,
        createdAt: new Date().toISOString(),
      })
    }

    initializeMessageQueue(target.id, loaded.records, (sessionId, record) => store.appendRecord(sessionId, record))
    checkpointServiceRef.current = new CheckpointService(process.cwd(), target.id)
    setSessionRecords(loaded.records)
    setActiveSession(target)
    replaceRuntime(nextRuntime)
    setCheckpoints([])
    resetTranscript(transcriptItems)
    setMode('idle')
  }, [activeSession.id, backgroundTasks, closeResumePicker, createRuntime, replaceRuntime, resetTranscript, store])

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
    getPermissionMode: () => permissionGate.getMode(),
    enterPlanMode: () => {
      const mode = applyPermissionModeTransition(permissionGate, runtimeRef.current.planModeManager, 'plan')
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
      await enqueueMessage(text)
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
  }, [addSystemMessage])

  useEffect(() => {
    if (
      queuePumpRunningRef.current
      || queuedMessages.length === 0
      || isStreaming
      || mode !== 'idle'
      || isOverlayActive
    ) return

    queuePumpRunningRef.current = true
    void (async () => {
      try {
        const next = await dequeueMessage()
        if (next) await executeQueuedInput(next.content)
      } catch (error) {
        addSystemMessage(`Failed to process queued message: ${error instanceof Error ? error.message : String(error)}`)
      } finally {
        queuePumpRunningRef.current = false
        setQueuePumpGeneration((value) => value + 1)
      }
    })()
  }, [queuedMessages, isStreaming, mode, isOverlayActive, executeQueuedInput, addSystemMessage, queuePumpGeneration])

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
    void clearMessageQueue().then(() => {
      addSystemMessage('Queued messages cleared.')
    }).catch((error) => {
      addSystemMessage(`Failed to clear queued messages: ${error instanceof Error ? error.message : String(error)}`)
    })
  }, [addSystemMessage])

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
    const records = await reloadMessages()
    await hydrateMessageQueue(records)
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
    const records = await reloadMessages()
    await hydrateMessageQueue(records)
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
    onClearQueue: handleClearQueue,
    onExit: handleExit,
    onEnterRestoreMode: handleEnterRestoreMode,
    onCyclePermissionMode: cyclePermissionMode,
    onToggleTranscript: handleToggleTranscript,
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

