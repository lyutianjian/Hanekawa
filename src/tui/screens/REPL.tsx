import { Box, Text, useInput, useApp, useBoxMetrics } from 'ink'
import type { DOMElement } from 'ink'
import { useRef } from 'react'
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

  // Input content line = total output height - 2 (bottom border + content line)
  const cursorY = rootMetrics.hasMeasured ? rootMetrics.height - 2 : 0

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
        <MessageList messages={messages} streamingMessageId={streamingMessageId} />
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
        <PromptInput onSubmit={handleSubmit} isDisabled={isRunning || !!pendingRequest} cursorY={cursorY} />
      </ThemedBox>
    </Box>
  )
}
