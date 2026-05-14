import { Box, useInput, useApp, useBoxMetrics } from 'ink'
import type { DOMElement } from 'ink'
import { useRef, useState, useCallback } from 'react'
import { basename } from 'node:path'
import { useSession } from '../hooks/useSession.js'
import { usePermissionPrompt } from '../hooks/usePermissionPrompt.js'
import { useAppState } from '../state/hooks.js'
import { MessageList } from '../components/MessageList.js'
import { PromptInput } from '../components/PromptInput.js'
import { Spinner } from '../components/Spinner.js'
import { SystemMessage } from '../components/SystemMessage.js'
import { PermissionPrompt } from '../components/PermissionPrompt.js'
import { ThemedBox } from '../design-system/ThemedBox.js'
import { ThemedText } from '../design-system/ThemedText.js'
import { useTheme } from '../design-system/ThemeProvider.js'
import type { Config } from '../../config/service.js'

interface REPLProps {
  config: Config
  cwd: string
  resumeSessionId?: string
}

export function REPL({ config, cwd, resumeSessionId }: REPLProps) {
  const { pendingRequest, approve, deny, approveAll } = usePermissionPrompt()
  const { messages, query, abort, clearMessages, sessionId } = useSession(config, cwd, resumeSessionId)
  const isRunning = useAppState((state) => state.isRunning)
  const startTime = useAppState((state) => state.startTime)
  const streamingMessageId = useAppState((state) => state.streamingMessageId)
  const error = useAppState((state) => state.error)
  const { exit } = useApp()
  const { colors } = useTheme()

  const rootRef = useRef<DOMElement | null>(null)
  const rootMetrics = useBoxMetrics(rootRef as React.RefObject<DOMElement>)
  const lastCtrlCTime = useRef(0)
  const isInputEmpty = useRef(true)
  const [focusedMessageId, setFocusedMessageId] = useState<string | null>(null)
  const [focusedToggleSignal, setFocusedToggleSignal] = useState(0)

  // Input content line = total output height - 2 (bottom border + content line)
  const cursorY = rootMetrics.hasMeasured ? rootMetrics.height - 2 : 0

  const handleInputEmpty = useCallback((isEmpty: boolean) => {
    isInputEmpty.current = isEmpty
    // Clear focus when user starts typing
    if (!isEmpty && focusedMessageId) {
      setFocusedMessageId(null)
    }
  }, [focusedMessageId])

  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      const now = Date.now()
      if (isRunning) {
        abort()
        lastCtrlCTime.current = now
      } else if (now - lastCtrlCTime.current < 500) {
        exit()
      } else {
        lastCtrlCTime.current = now
      }
    }
    if (key.ctrl && input === 'd') {
      exit()
    }

    // Message focus navigation (only when input is empty and not running)
    if (isInputEmpty.current && !pendingRequest) {
      if (key.upArrow) {
        const ids = messages.map(m => m.id)
        const currentIndex = focusedMessageId ? ids.indexOf(focusedMessageId) : -1
        if (currentIndex > 0) {
          setFocusedMessageId(ids[currentIndex - 1])
        } else if (currentIndex === -1 && ids.length > 0) {
          setFocusedMessageId(ids[ids.length - 1])
        }
        return
      }
      if (key.downArrow) {
        const ids = messages.map(m => m.id)
        const currentIndex = focusedMessageId ? ids.indexOf(focusedMessageId) : -1
        if (currentIndex >= 0 && currentIndex < ids.length - 1) {
          setFocusedMessageId(ids[currentIndex + 1])
        } else if (currentIndex === ids.length - 1) {
          setFocusedMessageId(null)
        }
        return
      }
      if (key.return && focusedMessageId) {
        setFocusedToggleSignal(prev => prev + 1)
        return
      }
    }
  })

  const handleSubmit = (text: string) => {
    if (text === '/clear') {
      clearMessages()
      return
    }
    query(text)
  }

  const dirName = basename(cwd)

  return (
    <Box ref={rootRef} flexDirection="column">
      {/* Header */}
      <ThemedBox borderStyle="single" borderBottom={true} borderColor="border" paddingX={1}>
        <ThemedText color="accent" bold>{'◈ MyAgent'}</ThemedText>
        {sessionId && (
          <ThemedText color="dimmed"> ({sessionId.slice(0, 8)})</ThemedText>
        )}
        <ThemedText color="dimmed"> │ {dirName}</ThemedText>
        <ThemedText color="dimmed"> │ {config.defaultModel ?? 'none'}</ThemedText>
      </ThemedBox>

      {/* Messages */}
      <Box flexDirection="column" paddingY={1}>
        <MessageList messages={messages} streamingMessageId={streamingMessageId} focusedMessageId={focusedMessageId} focusedToggleSignal={focusedToggleSignal} />
      </Box>

      {/* Spinner */}
      {isRunning && (
        <Box paddingX={1}>
          <Spinner label="Thinking..." startTime={startTime ?? undefined} />
        </Box>
      )}

      {/* Error display */}
      {error && (
        <SystemMessage content={error} variant="error" />
      )}

      {/* Permission prompt */}
      {pendingRequest && (
        <PermissionPrompt
          toolName={pendingRequest.toolName}
          riskLevel={pendingRequest.riskLevel}
          input={pendingRequest.input}
          onApprove={approve}
          onDeny={deny}
          onApproveAll={approveAll}
        />
      )}

      {/* Status line */}
      <Box paddingX={1}>
        <ThemedText color="dimmed">
          {config.defaultModel ?? 'none'}
          {messages.length > 0 && ` │ ${messages.length} msgs`}
        </ThemedText>
      </Box>

      {/* Input */}
      <ThemedBox borderStyle="single" borderTop={true} borderColor="border" paddingY={0}>
        <PromptInput onSubmit={handleSubmit} isDisabled={isRunning || !!pendingRequest} cursorY={cursorY} cwd={cwd} onInputEmpty={handleInputEmpty} />
      </ThemedBox>
    </Box>
  )
}
