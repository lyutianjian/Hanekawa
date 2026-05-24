import { useState, useCallback, useRef, useEffect } from 'react'
import { randomUUID } from 'node:crypto'
import { Box } from 'ink'
import type { AgentLoop } from '../../harness/loop.js'
import type { SessionStore, SessionMeta } from '../../sessions/service.js'
import type { PermissionGate, PermissionMode } from '../../harness/permissions.js'
import type { ModelConfig } from '../../config/service.js'
import type { SessionRecord } from '../../harness/types.js'
import type { SetModelResult } from '../../commands/types.js'
import type { TUIDisplayItem } from '../types.js'
import { useAgentLoop } from '../hooks/useAgentLoop.js'
import { useKeyboardShortcuts } from '../hooks/useKeyboardShortcuts.js'
import { useCommands } from '../hooks/useCommands.js'
import { usePermission } from '../hooks/usePermission.js'
import type { PermissionPromptProxy, RecordProxy } from '../hooks/usePermission.js'
import { CheckpointService } from '../../services/checkpoint/checkpointService.js'
import type { Checkpoint } from '../../services/checkpoint/checkpointService.js'
import { MessageList } from './MessageList.js'
import { InputBox } from './InputBox.js'
import { Spinner } from './Spinner.js'
import { PermissionDialog } from './PermissionDialog.js'
import { StatusLine } from './StatusLine.js'
import { WelcomeBanner } from './WelcomeBanner.js'
import { RestoreMode } from './RestoreMode.js'
import { invalidateResolvedCwdCache } from '../../utils/paths.js'

export type AppMode = 'idle' | 'running' | 'restore' | 'exiting'

const ABORT_TIMEOUT_MS = 2000
const PERMISSION_MODES: readonly PermissionMode[] = ['bypass', 'auto', 'acceptEdits', 'default', 'plan']

export interface AppRuntime {
  loop: AgentLoop
  modelKey: string
  modelConfig: ModelConfig
  providerName: string
}

interface AppProps {
  loop: AgentLoop
  modelKey: string
  store: SessionStore
  session: SessionMeta
  modelConfig: ModelConfig
  providerName: string
  availableModelKeys: string[]
  createRuntime: (modelKey: string, session: SessionMeta) => AppRuntime
  permissionGate: PermissionGate
  promptProxy: PermissionPromptProxy
  recordProxy: RecordProxy
  existingRecords: SessionRecord[]
  initialSystemMessages?: TUIDisplayItem[]
  onBeforeExit?: () => Promise<void>
  onPermissionModeChange?: (mode: PermissionMode) => Promise<void> | void
}

export function App({
  loop: initialLoop,
  modelKey: initialModelKey,
  store,
  session: initialSession,
  modelConfig: initialModelConfig,
  providerName: initialProviderName,
  availableModelKeys,
  createRuntime,
  permissionGate,
  promptProxy,
  recordProxy,
  existingRecords,
  initialSystemMessages,
  onBeforeExit,
  onPermissionModeChange,
}: AppProps) {
  const [mode, setMode] = useState<AppMode>('idle')
  const [activeSession, setActiveSession] = useState<SessionMeta>(initialSession)
  const [runtime, setRuntime] = useState<AppRuntime>(() => ({
    loop: initialLoop,
    modelKey: initialModelKey,
    modelConfig: initialModelConfig,
    providerName: initialProviderName,
  }))
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([])
  const [permissionMode, setPermissionModeState] = useState<PermissionMode>(() => permissionGate.getMode())
  const abortTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const checkpointServiceRef = useRef<CheckpointService>(
    new CheckpointService(process.cwd(), initialSession.id),
  )

  const { permState, respond } = usePermission(promptProxy)

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
    setRuntime((current) => {
      if (current.modelKey === activeModel.modelKey) return current
      return { ...nextRuntime, loop: current.loop }
    })
  }, [createRuntime, activeSession, runtime.modelKey])

  const {
    messages,
    setMessages,
    isStreaming,
    usage,
    submit,
    interrupt,
    handleRecord,
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
  })

  // Track running state in mode
  // When isStreaming changes, update mode accordingly
  const effectiveMode: AppMode = isStreaming ? 'running' : mode

  // Helper to add system messages from commands
  const addSystemMessage = useCallback((content: string) => {
    const systemMsg: TUIDisplayItem = {
      kind: 'system',
      id: randomUUID(),
      content,
      createdAt: new Date().toISOString(),
    }
    setMessages((prev) => [...prev, systemMsg])
  }, [setMessages])

  const clearConversation = useCallback(async () => {
    runtime.loop.clearCachedSections()
    const nextSession = await store.create()
    const nextRuntime = createRuntime(runtime.modelKey, nextSession)
    checkpointServiceRef.current = new CheckpointService(process.cwd(), nextSession.id)
    setActiveSession(nextSession)
    setRuntime(nextRuntime)
    setCheckpoints([])
    setMessages([])
  }, [store, createRuntime, runtime.modelKey, runtime.loop, setMessages])

  const switchModel = useCallback((modelKey: string): SetModelResult => {
    if (!availableModelKeys.includes(modelKey)) {
      return {
        ok: false,
        message: `Unknown model: ${modelKey}`,
        availableModels: availableModelKeys,
      }
    }

    try {
      const nextRuntime = createRuntime(modelKey, activeSession)
      runtime.loop.clearCachedSections()
      setRuntime(nextRuntime)
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
        availableModels: availableModelKeys,
      }
    }
  }, [availableModelKeys, createRuntime, activeSession, runtime.loop])

  const cyclePermissionMode = useCallback((direction: 1 | -1) => {
    setPermissionModeState((currentMode) => {
      const index = PERMISSION_MODES.indexOf(currentMode)
      const normalizedIndex = index >= 0 ? index : PERMISSION_MODES.indexOf('default')
      const nextIndex = (normalizedIndex + direction + PERMISSION_MODES.length) % PERMISSION_MODES.length
      const nextMode = PERMISSION_MODES[nextIndex] ?? 'default'
      permissionGate.setMode(nextMode)
      return nextMode
    })
  }, [permissionGate])

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
  })

  const handleSubmit = async (text: string) => {
    if (text.startsWith('/')) {
      await dispatch(text)
      return
    }
    setMode('running')
    await submit(text)
    setMode('idle')
  }

  const handleInterrupt = useCallback(() => {
    // Signal the AbortController to abort the agent loop
    interrupt()

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
      setMessages((prev) => [...prev, partialMsg])
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
    setMessages((prev) => [...prev, successMsg])
    setMode('idle')
  }, [store, activeSession.id, reloadMessages, setMessages])

  // Clean up abort timeout when streaming stops
  if (!isStreaming && abortTimeoutRef.current) {
    clearTimeout(abortTimeoutRef.current)
    abortTimeoutRef.current = null
  }

  const { text, cursorPos, hintMessage } = useKeyboardShortcuts({
    onSubmit: handleSubmit,
    onInterrupt: handleInterrupt,
    onExit: handleExit,
    onEnterRestoreMode: handleEnterRestoreMode,
    onCyclePermissionMode: cyclePermissionMode,
    isStreaming,
    isRestoreMode: mode === 'restore',
    isPermissionVisible: permState.visible,
  })

  return (
    <Box flexDirection="column" width="100%">
      {/* Welcome banner (always visible) */}
      <WelcomeBanner
        sessionShortId={activeSession.shortId}
        model={runtime.modelConfig.model}
        providerName={runtime.providerName}
        cwd={process.cwd()}
      />

      {/* Message list */}
      <MessageList
        items={messages}
      />

      {/* Spinner during streaming */}
      {isStreaming && <Spinner />}

      {/* Permission dialog */}
      {permState.visible && (
        <PermissionDialog permState={permState} respond={respond} />
      )}

      {/* Restore mode overlay */}
      {mode === 'restore' && (
        <RestoreMode
          checkpoints={checkpoints}
          onSelect={handleRestoreSelect}
          onCancel={handleRestoreCancel}
        />
      )}

      {/* Input box (with horizontal lines) */}
      {mode !== 'restore' && (
        <InputBox
          text={text}
          cursorPos={cursorPos}
          disabled={isStreaming || permState.visible}
        />
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
