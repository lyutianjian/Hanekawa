import { useState, useCallback, useRef, useEffect, useMemo, useSyncExternalStore } from 'react'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { Box, Static, Text, snapshotInkFrameForStdout, useStdout } from '../ink.js'
import { theme } from '../theme.js'
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
import type { CheckpointWithDiff } from '../../services/fileHistory/types.js'
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
import type { QueuedSubmissionHandoff, SessionController } from '../../runtime/sessionController.js'
import { canPumpQueue, handOffQueuedMessage } from '../../runtime/queuePump.js'
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
import { MODEL_CONTEXT_WINDOW_DEFAULT } from '../../prompts/budget.js'
import { shouldRenderStatusLine } from '../statusLineVisibility.js'
import { createQueueImageRebinder } from '../../runtime/attachmentHandoff.js'
import { MessageQueue } from '../../runtime/messageQueue.js'
import { MODEL_CONFIGURATION_REQUIRED } from '../../runtime/errors.js'
import type { UserInput } from '../../media/types.js'
import { describeImageBlockError, formatImageFailure } from '../../media/imageErrors.js'
import type { BackgroundTaskRegistry } from '../../services/backgroundTasks/registry.js'
import type { ImageAttachmentService } from '../../services/imageAttachments/imageAttachmentService.js'
import { captureClipboardImage } from '../utils/imageClipboard.js'
import { parseStandaloneImagePath, resolvePastedPath } from '../utils/pastedImagePath.js'
import {
  draftImageRefs,
  formatDraftAttachmentLine,
  keepsDraftAttachments,
  removeDraftImageAt,
  type DraftImage,
} from '../utils/imageDrafts.js'
import { DraftAttachments } from './DraftAttachments.js'
import { appendPromptHistory, loadPromptHistory, promptHistoryTexts } from '../../runtime/promptHistory.js'
import { summarizeDiagnosticsForTui } from '../../harness/diagnostics.js'
import {
  refreshRuntimeSlot,
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
  /** Persists the thinking switch and reloads settings; the loop is updated here. */
  onThinkingChange?: (enabled: boolean) => Promise<void> | void
  backgroundTasks: BackgroundTaskRegistry
  /** This project's image attachment store; draft imports and reads go through it. */
  attachments: ImageAttachmentService
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
  onThinkingChange,
  backgroundTasks,
  attachments,
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
  const { session: runtime, effort: effortLevel, configurationIssue } = useSyncExternalStore(
    runtimeSlot.subscribe,
    runtimeSlot.getSnapshot,
    runtimeSlot.getSnapshot,
  )
  const [checkpoints, setCheckpoints] = useState<CheckpointWithDiff[]>([])
  const [permissionMode, setPermissionModeState] = useState<PermissionMode>(() => permissionGate.getMode())
  const [modelKeys, setModelKeys] = useState<string[]>(availableModelKeys)
  const [providerPanelOpen, setProviderPanelOpen] = useState(() => !runtimeSlot.current)
  const [modelPickerOpen, setModelPickerOpen] = useState(false)
  const [effortPickerOpen, setEffortPickerOpen] = useState(false)
  const [activeCommandView, setActiveCommandView] = useState<CommandView | null>(null)
  const abortTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const restoreInputRef = useRef<(input: UserInput) => void>(() => {})
  const latestStaticItemCountRef = useRef(0)
  const transcriptStaticItemCountRef = useRef<number | null>(null)
  const promptFrameSnapshotRef = useRef<InkFrameSnapshot | undefined>(undefined)
  const [spinnerColors, setSpinnerColors] = useState(() => sampleSpinnerColors())
  const [queuePumpGeneration, setQueuePumpGeneration] = useState(0)
  const queuePumpRunningRef = useRef(false)
  /**
   * The queued message the runtime refused, with the runtime that refused it.
   *
   * Keyed to the `AgentSession` so any runtime swap — `/model`, a provider edit
   * that turns image input on — releases the hold, the desktop host's rule.
   */
  const queueBlockRef = useRef<{ messageId: string; session: AgentSession | undefined } | null>(null)
  const pendingProviderScopeRef = useRef<ProviderConfigChangeScope | undefined>(undefined)
  const initialQueuedPromptRef = useRef(initialQueuedPrompt)
  const [messageQueue] = useState(() => new MessageQueue(
    initialSession.id,
    existingRecords,
    (sessionId, record) => store.appendRecord(sessionId, record),
    // The accept-time gate, same as the desktop host's: an input the active
    // model cannot take is refused while `handleSubmit` still holds the text
    // and the draft images, rather than being persisted and refused later.
    (input) => {
      // Local commands must remain reachable during setup. Commands that submit
      // a prompt pass through the controller's readiness check when they run.
      if (!input.text.startsWith('/')) sessionController.assertInputAcceptable(input)
    },
  ))
  const queuedMessages = useSyncExternalStore(
    messageQueue.subscribe,
    messageQueue.getSnapshot,
    messageQueue.getSnapshot,
  )
  const [screen, setScreen] = useState<'prompt' | 'transcript'>('prompt')
  const [transcriptScrollOffsetRows, setTranscriptScrollOffsetRows] = useState(0)
  // Draft image attachments (S14): imported files waiting for the next real
  // message. The refs mirror the state so submit, restore, and import
  // callbacks read the live list without listing it in every dependency
  // array — same assignment-during-render pattern `useCommands` documents.
  const [draftImages, setDraftImages] = useState<DraftImage[]>([])
  const [importingImages, setImportingImages] = useState(0)
  const draftImagesRef = useRef<DraftImage[]>([])
  draftImagesRef.current = draftImages
  const activeSessionIdRef = useRef(activeSession.id)
  activeSessionIdRef.current = activeSession.id
  /** The composer API the paste-failure restore path needs; filled once the keyboard hook returns it. */
  const composerApiRef = useRef<{
    getText: () => string
    setText: (text: string) => void
    setCursorPos: (pos: number) => void
  } | null>(null)
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

  const restoreInput = useCallback((input: UserInput) => {
    restoreInputRef.current(input)
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
    pricing: runtime?.modelConfig.pricing,
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
   * Imports bytes as a draft attachment owned by the session that was active
   * when the import started. `onImportFailed` runs only on failure — the
   * caller uses it to put a claimed paste back into the composer.
   */
  const importDraftImage = useCallback(async (
    bytes: Buffer,
    name: string,
    onImportFailed?: () => void,
  ): Promise<boolean> => {
    const ownerSessionId = activeSessionIdRef.current
    setImportingImages((count) => count + 1)
    try {
      const result = await attachments.importImage(ownerSessionId, bytes, name)
      if (!result.ok) {
        addSystemMessage(`Image not attached: ${formatImageFailure(result.reason, result.message)}`)
        onImportFailed?.()
        return false
      }
      // An import that outlived a session switch must not land in the new
      // session's draft; the stored file stays with the session that owns it.
      if (activeSessionIdRef.current !== ownerSessionId) {
        addSystemMessage(`Session changed while importing ${name}; the image stayed with its session.`)
        return true
      }
      setDraftImages((current) => [
        ...current,
        { ref: result.value.ref, ...(result.value.animated ? { animated: true } : {}) },
      ])
      addSystemMessage(
        `Attached ${result.value.ref.name} (${result.value.ref.width}x${result.value.ref.height}); it will be sent with your next message.`,
      )
      return true
    } finally {
      setImportingImages((count) => count - 1)
    }
  }, [attachments, addSystemMessage])

  /** `/paste-image` and Ctrl+V run the same action: capture once, import once. */
  const pasteImageFromClipboard = useCallback(async () => {
    const captured = await captureClipboardImage()
    if (!captured.ok) {
      addSystemMessage(captured.message)
      return
    }
    const extension = captured.format === 'jpeg' ? 'jpg' : captured.format
    await importDraftImage(captured.bytes, `clipboard.${extension}`)
  }, [addSystemMessage, importDraftImage])

  const importPastedImagePath = useCallback(async (
    cleanedPath: string,
    previousText: string,
    previousCursorPos: number,
  ) => {
    // Re-insert the paste only when the composer is exactly what it was when
    // the paste was claimed, so a failed import never overwrites a newer draft.
    const restorePastedText = () => {
      const composer = composerApiRef.current
      if (!composer || composer.getText() !== previousText) return
      composer.setText(
        previousText.slice(0, previousCursorPos) + cleanedPath + previousText.slice(previousCursorPos),
      )
      composer.setCursorPos(previousCursorPos + cleanedPath.length)
    }
    const absolutePath = resolvePastedPath(cleanedPath, { cwd: process.cwd(), homedir: homedir() })
    let bytes: Buffer
    try {
      bytes = await readFile(absolutePath)
    } catch {
      addSystemMessage(
        `Image not attached: ${cleanedPath} does not exist or cannot be read. Paste the full path of an image file, or reference a project image with @path.`,
      )
      restorePastedText()
      return
    }
    await importDraftImage(bytes, path.basename(absolutePath), restorePastedText)
  }, [addSystemMessage, importDraftImage])

  /**
   * Claims multi-character pastes that are nothing but one standalone image
   * path; every other paste keeps its text semantics and reaches the composer.
   */
  const handlePastedText = useCallback((
    pasted: string,
    currentText: string,
    cursorPosition: number,
  ): boolean => {
    const candidate = parseStandaloneImagePath(pasted)
    if (candidate === null) return false
    void importPastedImagePath(candidate.path, currentText, cursorPosition)
    return true
  }, [importPastedImagePath])

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
      // The images ride along by being copied into the new session first, so
      // nothing that survives `/clear` still depends on the old one (S23).
      beforeApply: (next) => messageQueue.migrateTo(next.id, [], createQueueImageRebinder(attachments)),
    }, { previousSessionId: activeSession.id })
    setActiveSession(result.session)
    resetSessionRecords([])
    setCheckpoints([])
    resetTranscript([])
    // The drafts belong to the old session's attachments; the files stay with
    // it, the composer starts the new session clean (ownership rules: S23).
    setDraftImages([])
  }, [sessionSwitchDeps, messageQueue, attachments, activeSession.id, resetSessionRecords, resetTranscript])

  const buildRunOverridesForOptions = useCallback((options?: CommandSubmitQueryOptions) => (
    buildRunOverrides({ config: providerConfig, runtimeSlot, createActiveModelRuntime }, options)
  ), [createActiveModelRuntime, providerConfig, runtimeSlot])

  const submitPlainInput = useCallback(async (text: string, options?: CommandSubmitQueryOptions) => {
    setSpinnerColors(sampleSpinnerColors())
    setMode('running')
    // Command-generated user input (skills, `/plan`) carries the draft images
    // with it, so the generated message keeps its image refs (S14).
    const images = draftImageRefs(draftImagesRef.current)
    try {
      await submit({ text, ...(images ? { images } : {}) }, buildRunOverridesForOptions(options))
      if (images) setDraftImages([])
    } finally {
      setMode('idle')
    }
  }, [submit, buildRunOverridesForOptions])

  const runShellCommand = useCallback(async (command: string) => {
    const result = await runtimeSlot.requireCurrent().loop.runTool({
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
    if (!prompt || !runtime) return
    initialQueuedPromptRef.current = undefined
    void messageQueue.enqueue({ text: prompt }).catch((error) => {
      addSystemMessage(`Failed to queue prompt: ${error instanceof Error ? error.message : String(error)}`)
    })
  }, [messageQueue, addSystemMessage, runtime])

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
    if (sessionController.getSnapshot().isStreaming) {
      if (pendingProviderScopeRef.current !== 'routing') pendingProviderScopeRef.current = scope
      return
    }
    const modelKey = resolveRuntimeModelKeyAfterConfigChange(
      providerConfig,
      runtimeSlot.current?.modelKey,
      scope,
    )
    refreshRuntimeSlot({ config: providerConfig, runtimeSlot, createRuntime, modelKey, session: activeSession, records: sessionRecordsRef.current })
  }, [providerConfig, createRuntime, activeSession, runtimeSlot, sessionController])

  useEffect(() => {
    if (isStreaming || !pendingProviderScopeRef.current) return
    const scope = pendingProviderScopeRef.current
    pendingProviderScopeRef.current = undefined
    refreshRuntimeAfterProviderConfigChange(scope)
  }, [isStreaming, refreshRuntimeAfterProviderConfigChange])

  const handleSetEffort = useCallback((level: string) => {
    const clampedLevel = runtimeSlot.setEffort(level)
    onEffortLevelChange?.(clampedLevel)
  }, [onEffortLevelChange, runtimeSlot])

  const handleSetThinking = useCallback(async (enabled: boolean) => {
    runtimeSlot.current?.loop.setThinking(enabled ? { type: 'adaptive' } : { type: 'disabled' })
    await onThinkingChange?.(enabled)
  }, [onThinkingChange, runtimeSlot])

  const modelPickerOptions = useMemo(
    () => buildModelPickerOptions(providerConfig, runtime?.modelKey, modelKeys),
    [providerConfig, runtime?.modelKey, modelKeys],
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

    // No confirmation of the switch itself — the status line already names the
    // live model, and `/model` stopped printing one for the same reason. What
    // stays is what nothing else shows: the config write-back, and the
    // image-impact notice `/model` also prints.
    const lines: string[] = []
    if (decision.action === 'set-default') lines.push('Default model updated.')
    if (result.notice) lines.push(result.notice)
    if (lines.length > 0) addSystemMessage(lines.join('\n'))
  }, [providerConfig, activateModel, addSystemMessage])

  const reloadAgentDefinitions = useCallback(async (): Promise<number> => {
    if (!reloadRuntimeAgentDefinitions) {
      throw new Error('Agent definition reload is not available in this runtime.')
    }
    const count = await reloadRuntimeAgentDefinitions()
    refreshRuntimeAfterProviderConfigChange('models')
    return count
  }, [reloadRuntimeAgentDefinitions, refreshRuntimeAfterProviderConfigChange])

  const reloadSkills = useCallback(async (): Promise<number> => {
    if (!reloadRuntimeSkills) {
      throw new Error('Skill reload is not available in this runtime.')
    }
    const count = await reloadRuntimeSkills()
    // Same shape as the agent-definition reload: skills feed the system prompt
    // through `createRuntime`, so the live runtime has to be rebuilt to see them.
    refreshRuntimeAfterProviderConfigChange('models')
    return count
  }, [reloadRuntimeSkills, refreshRuntimeAfterProviderConfigChange])

  const cyclePermissionMode = useCallback((direction: 1 | -1) => {
    setPermissionModeState((currentMode) => {
      const nextMode = nextPermissionMode(currentMode, direction)
      return applyPermissionModeTransition(permissionGate, runtimeSlot.current?.planModeManager, nextMode)
    })
  }, [permissionGate, runtimeSlot])

  useEffect(() => {
    runtime?.planModeManager.setUiDeps({
      emitChatMessage: async (content) => addSystemMessage(content),
      openEnterPrompt: enterPlanProxy.open,
      openExitDialog: exitPlanProxy.open,
    })
  }, [runtime?.planModeManager, addSystemMessage, enterPlanProxy, exitPlanProxy])

  const planFileDeps = useMemo(
    () => ({ getPlanModeManager: () => runtimeSlot.requireCurrent().planModeManager }),
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
      const cpService = sessionController.getFileHistoryService()
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
    // Same ownership rule as `/clear`: the drafts stay with the session they
    // were imported into.
    setDraftImages([])
  }, [activeSession.id, closeResumePicker, sessionSwitchDeps, messageQueue, resetTranscript, resetSessionRecords])

  const { dispatch } = useCommands({
    store,
    session: activeSession,
    commands,
    cwd: process.cwd(),
    model: runtime ? {
      key: runtime.modelKey,
      model: runtime.modelConfig.model,
      providerName: runtime.providerName,
    } : undefined,
    setModel: switchToModel,
    pricing: runtime?.modelConfig.pricing,
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
    clearCachedSections: () => runtime?.loop.clearCachedSections(),
    invalidateRecordsCache: () => runtime?.loop.invalidateRecordsCache(),
    reloadAgentDefinitions,
    reloadSkills,
    getPermissionMode: () => permissionGate.getMode(),
    enterPlanMode: () => {
      const mode = applyPermissionModeTransition(permissionGate, runtimeSlot.current?.planModeManager, 'plan')
      setPermissionModeState(mode)
    },
    readPlanFile: readCurrentPlanFile,
    openPlanFile: openCurrentPlanFile,
    submitQuery: submitPlainInput,
    pasteImageFromClipboard,
    listDraftAttachments: () => draftImagesRef.current.map(
      (image, index) => formatDraftAttachmentLine(index + 1, image),
    ),
    removeDraftAttachment: (index: number) => {
      const result = removeDraftImageAt(draftImagesRef.current, index)
      if (result.ok) setDraftImages(result.next)
      return { ok: result.ok, ...(result.message ? { message: result.message } : {}) }
    },
    clearDraftAttachments: () => setDraftImages([]),
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
    getThinking: () => runtimeSlot.current?.loop.getThinking()?.type !== 'disabled',
    setThinking: handleSetThinking,
  })

  /**
   * The queue's hand-off: a queued message becomes a full UserInput again.
   *
   * `handoff` carries the consume signal down to the controller, which fires it
   * when the user record lands — the message is only removed from the queue
   * then, so a submission the runtime refuses stays queued with its images.
   * A slash command has no user record; `handOffQueuedMessage` consumes it on a
   * clean return instead.
   */
  const executeQueuedInput = useCallback(async (
    input: UserInput,
    handoff: QueuedSubmissionHandoff,
  ) => {
    if (input.text.startsWith('/')) {
      await dispatch(input.text)
      return
    }
    setSpinnerColors(sampleSpinnerColors())
    setMode('running')
    try {
      await sessionController.submit(input, buildRunOverridesForOptions(undefined), handoff)
    } finally {
      setMode('idle')
    }
  }, [dispatch, sessionController, buildRunOverridesForOptions])

  const handleSubmit = useCallback(async (text: string): Promise<boolean> => {
    if (!runtime && text.startsWith('/')) {
      // Setup/help must also work when an older queued prompt is waiting for a
      // model. Such a prompt cannot be allowed to park the configuration UI.
      await dispatch(text)
      return true
    }
    // Slash commands never take the drafts with them: control commands only
    // act, and skill/plan queries consume the drafts at `submitQuery` time.
    // Only a plain message carries the draft images out of the composer.
    const isCommandInput = keepsDraftAttachments(text)
    const images = isCommandInput ? undefined : draftImageRefs(draftImagesRef.current)
    try {
      await messageQueue.enqueue({ text, ...(images ? { images } : {}) })
      void appendPromptHistory(text, process.cwd()).then((entry) => {
        if (!entry) return
        setPromptHistory((current) => [...current, entry.text].slice(-1000))
      }).catch((error) => {
        if (historyWarningShownRef.current) return
        historyWarningShownRef.current = true
        addSystemMessage(`Input history could not be saved: ${error instanceof Error ? error.message : String(error)}`)
      })
      if (!isCommandInput) setDraftImages([])
      return true
    } catch (error) {
      // The accept-time gate refuses images the active model cannot take; the
      // refusal is the only thing the user sees, so it carries its exit (S24).
      addSystemMessage(`Failed to queue message: ${describeImageBlockError(error)}`)
      return false
    }
  }, [addSystemMessage, messageQueue, runtime, dispatch])

  useEffect(() => {
    // `mode` folds two unrelated ideas together: 'running' means a turn is in
    // flight, everything else non-idle means a surface is holding the screen.
    // The headless policy keeps them apart so a desktop shell can substitute
    // "a permission request is pending" for the second one.
    const block = queueBlockRef.current
    if (!canPumpQueue({
      pending: queuedMessages.length,
      running: queuePumpRunningRef.current,
      turnActive: isStreaming || mode === 'running',
      uiBlocked: isOverlayActive || mode !== 'idle',
      headMessageId: messageQueue.peek()?.id,
      ...(block && block.session === runtime ? { blockedMessageId: block.messageId } : {}),
    })) return

    queuePumpRunningRef.current = true
    void (async () => {
      try {
        const outcome = await handOffQueuedMessage({
          peek: () => messageQueue.peek(),
          consume: (messageId) => messageQueue.consume(messageId),
          deliver: executeQueuedInput,
        })
        if (outcome.kind === 'blocked') {
          // Paused, not retried: the runtime refused this message before taking
          // it, so the same model and the same attachments would refuse again.
          // Switching models replaces `runtime`, which releases the hold.
          queueBlockRef.current = { messageId: outcome.message.id, session: runtime }
          addSystemMessage(`Queued message paused: ${outcome.reason}`)
        } else if (outcome.kind === 'failed') {
          addSystemMessage(`Failed to send queued message: ${outcome.reason}`)
        }
      } catch (error) {
        addSystemMessage(`Failed to process queued message: ${error instanceof Error ? error.message : String(error)}`)
      } finally {
        queuePumpRunningRef.current = false
        setQueuePumpGeneration((value) => value + 1)
      }
    })()
  }, [queuedMessages, isStreaming, mode, isOverlayActive, executeQueuedInput, addSystemMessage, messageQueue, queuePumpGeneration, runtime])

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
    runtime?.loop.invalidateRecordsCache()
    const records = await reloadMessages()
    rebaseSessionRecords(records)
    await messageQueue.hydrate(records)
  }, [store, activeSession.id, runtime?.loop, reloadMessages, rebaseSessionRecords, messageQueue])

  const restoreCodeToCheckpoint = useCallback(async (checkpoint: CheckpointWithDiff) => {
    const cpService = sessionController.getFileHistoryService()
    const restoreResult = await cpService.rewindTo(checkpoint.messageId)
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
      summarize: (records) => runtimeSlot.requireCurrent().loop.summarizeRecordsForRewind(records),
    })

    await store.replaceRecords(activeSession.id, rewrite.nextRecords)
    runtime?.loop.invalidateRecordsCache()
    const records = await reloadMessages()
    rebaseSessionRecords(records)
    await messageQueue.hydrate(records)
  }, [store, activeSession.id, runtime?.loop, runtimeSlot, reloadMessages, rebaseSessionRecords, messageQueue])

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
    onPasteImage: () => { void pasteImageFromClipboard() },
    onPastedText: handlePastedText,
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

  restoreInputRef.current = (restored: UserInput) => {
    // The rollback restored the input as it was submitted: the text returns
    // to the composer and the image refs return to the draft list. The
    // animated-first-frame annotation is import-time knowledge a bare ref
    // does not carry, so a restored draft lists without it.
    setText(restored.text)
    setCursorPos(restored.text.length)
    if (restored.images && restored.images.length > 0) {
      setDraftImages(restored.images.map((ref) => ({ ref })))
    }
  }

  // Assigned during render so the paste-failure restore always sees the
  // composer state of the latest committed frame, never a stale one.
  composerApiRef.current = {
    getText: () => text,
    setText,
    setCursorPos,
  }

  const staticItems: TUIStaticItem[] = [
    {
      kind: 'welcome_banner',
      id: `welcome-${activeSession.id}`,
      sessionShortId: activeSession.shortId,
      model: runtime?.modelConfig.model ?? '待配置',
      providerName: runtime?.providerName ?? '',
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

      {!runtime && <Text color={theme.brand}>{configurationIssue?.message} {MODEL_CONFIGURATION_REQUIRED}</Text>}

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
              supportedEfforts={runtime?.modelConfig.supportedEfforts}
              onResolve={(result) => {
                setEffortPickerOpen(false)
                if (result.action === 'set') handleSetEffort(result.level)
              }}
            />
          )}

          {activeCommandView && (
            <CommandViewPanel view={activeCommandView} onClose={() => setActiveCommandView(null)} />
          )}

          {/* Draft image attachments (S14): numbered list above the input */}
          {mode !== 'restore' && mode !== 'tasks' && mode !== 'resume' && !providerPanelOpen && !modelPickerOpen && !effortPickerOpen && !activeCommandView && (
            <DraftAttachments images={draftImages} importingCount={importingImages} />
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
          model={runtime?.modelConfig.model ?? '待配置 · /provider'}
          usage={usage}
          permissionMode={permissionMode}
          hintMessage={hintMessage}
          effortLevel={effortLevel}
          contextWindow={runtime ? getContextWindowForModel(
            {
              ...providerConfig.get().agent.contextManagement,
              contextWindow: runtime.modelConfig.contextWindow ?? MODEL_CONTEXT_WINDOW_DEFAULT,
            },
          ) : undefined}
          backgroundTaskCount={backgroundTaskSnapshot.filter((task) => task.status === 'running').length}
        />
      )}
    </Box>
  )
}
