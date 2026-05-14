// 主 REPL 屏幕 — 集成 AgentLoop 流式输出

import React, { useState, useRef, useCallback, useEffect } from 'react'
import { Box, Text } from '../ink.js'
import { useApp } from 'ink'
import { Divider } from '../design-system/Divider.js'
import { OverlayProvider } from '../context/overlayContext.js'
import { MessageRow } from '../components/messages/MessageRow.js'
import { SpinnerWithVerb } from '../components/Spinner/SpinnerWithVerb.js'
import { PromptInput } from '../components/PromptInput.js'
import { Footer } from '../components/Footer.js'
import { PermissionDialog } from '../components/permissions/PermissionDialog.js'
import { ToolPermissionCard } from '../components/permissions/ToolPermissionCard.js'
import { SettingsScreen } from '../components/SettingsScreen.js'
import { HelpScreen } from '../components/HelpScreen.js'
import { CompactionIndicator } from '../components/CompactionIndicator.js'
import { useAppState, useSetAppState } from '../state/AppState.js'
import type { ChatMessage } from '../components/messages/types.js'
import { handleSlashCommand } from '../commands/slashCommands.js'
import type { AgentLoop } from '../../harness/loop.js'
import type { AgentStreamEvent } from '../../harness/types.js'
import type { Store } from '../state/store.js'
import type { AppState } from '../state/AppStateStore.js'
import type { SessionStore } from '../../sessions/service.js'
import { useSession } from '../hooks/useSession.js'

type REPLProps = {
  loop?: AgentLoop
  session?: { id: string; shortId?: string; createdAt?: string }
  appStore?: Store<AppState>
  sessionStore?: SessionStore
}

export function REPL({ loop, session, appStore, sessionStore }: REPLProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [isRunning, setIsRunning] = useState(false)
  const [streamingText, setStreamingText] = useState('')
  const [totalUsage, setTotalUsage] = useState<{ input: number; output: number; cost: number } | null>(null)
  const [pendingModel, setPendingModel] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  const { exit } = useApp()
  const nextId = useRef(0)
  const responseLengthRef = useRef(0)
  const abortRef = useRef<AbortController | null>(null)

  const pendingPermission = useAppState(s => s.pendingPermission)
  const setAppState = useSetAppState()

  // Session 持久化
  const { loadHistory, saveMessage } = useSession({
    store: sessionStore!,
    sessionId: session?.id || '',
  })

  // 启动时加载历史消息
  useEffect(() => {
    if (session && sessionStore) {
      loadHistory().then(history => {
        if (history.length > 0) {
          setMessages(history)
        }
      })
    }
  }, [session?.id])

  const handleSubmit = useCallback(async (text: string) => {
    // Slash 命令处理
    const slashResult = handleSlashCommand(text, {
      model: pendingModel || 'current-model',
      sessionId: session?.id,
      messageCount: messages.length,
      createdAt: session?.createdAt,
    })
    if (slashResult.handled) {
      if (text.trim() === '/help') {
        setHelpOpen(true)
        return
      }
      if (slashResult.message) {
        setMessages(prev => [...prev, slashResult.message!])
      }
      if (text.trim() === '/clear') {
        setMessages([])
      }
      if (text.trim() === '/settings') {
        setSettingsOpen(true)
      }
      if (slashResult.action === 'switch_model' && slashResult.model) {
        setPendingModel(slashResult.model)
      }
      return
    }

    // 添加用户消息
    const userMsg: ChatMessage = {
      id: `msg-${nextId.current++}`,
      role: 'user',
      content: text,
      timestamp: Date.now(),
    }
    setMessages(prev => [...prev, userMsg])
    saveMessage(userMsg)
    setIsRunning(true)
    setStreamingText('')
    responseLengthRef.current = 0

    if (!loop) {
      // 无 AgentLoop，echo 模式
      setTimeout(() => {
        const assistantMsg: ChatMessage = {
          id: `msg-${nextId.current++}`,
          role: 'assistant',
          content: `Echo: ${text}`,
          timestamp: Date.now(),
        }
        setMessages(prev => [...prev, assistantMsg])
        saveMessage(assistantMsg)
        setIsRunning(false)
      }, 500)
      return
    }

    // 使用 AgentLoop 流式执行
    const abort = new AbortController()
    abortRef.current = abort

    try {
      const result = await loop.run(text, abort.signal, (event: AgentStreamEvent) => {
        switch (event.type) {
          case 'text_delta':
            setStreamingText(event.snapshot)
            responseLengthRef.current = event.snapshot.length
            break
          case 'tool_use_start':
            // 添加工具使用消息
            setMessages(prev => [...prev, {
              id: `msg-${nextId.current++}`,
              role: 'assistant',
              content: [{ type: 'tool_use' as const, id: event.toolId, name: event.toolName, input: {} }],
              timestamp: Date.now(),
            }])
            break
        }
      })

      // 流式完成后，添加最终消息
      if (result.content) {
        const assistantMsg: ChatMessage = {
          id: `msg-${nextId.current++}`,
          role: 'assistant',
          content: result.content,
          timestamp: Date.now(),
        }
        setMessages(prev => [...prev, assistantMsg])
        saveMessage(assistantMsg)
      }

      // 更新使用量
      if (result.usage) {
        setTotalUsage(prev => ({
          input: (prev?.input || 0) + (result.usage.inputTokens || 0),
          output: (prev?.output || 0) + (result.usage.outputTokens || 0),
          cost: (prev?.cost || 0), // cost 需要根据定价计算，暂不实现
        }))
      }
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        const errorMsg: ChatMessage = {
          id: `msg-${nextId.current++}`,
          role: 'system',
          content: `Error: ${(err as Error).message}`,
          timestamp: Date.now(),
        }
        setMessages(prev => [...prev, errorMsg])
        saveMessage(errorMsg)
      }
    } finally {
      setIsRunning(false)
      setStreamingText('')
      abortRef.current = null
    }
  }, [loop])

  const handleCancel = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort()
    }
  }, [])

  return (
    <OverlayProvider>
      <Box flexDirection="column" height="100%">
        {/* Header */}
        <Box flexDirection="column">
          <Box paddingX={1}>
            <Text bold color="cyan"> myagent</Text>
            <Text dimColor> </Text>
            <Divider />
          </Box>
          <Box paddingX={2} gap={2}>
            <Text>
              <Text color="green">●</Text>
              <Text> {pendingModel || 'claude-sonnet-4'}</Text>
            </Text>
            <Text dimColor>│</Text>
            <Text dimColor>Session: {session?.id?.slice(0, 8) || 'none'}</Text>
            {totalUsage && (
              <>
                <Text dimColor>│</Text>
                <Text>
                  <Text color="yellow">Tokens:</Text>
                  <Text> {(totalUsage.input + totalUsage.output).toLocaleString()}</Text>
                </Text>
                <Text dimColor>│</Text>
                <Text>
                  <Text color="green">$</Text>
                  <Text>{totalUsage.cost.toFixed(4)}</Text>
                </Text>
              </>
            )}
            {pendingModel && (
              <>
                <Text dimColor>│</Text>
                <Text color="yellow">{'->'} {pendingModel}</Text>
              </>
            )}
          </Box>
          <Divider />
        </Box>
        <CompactionIndicator
          tokenCount={totalUsage ? totalUsage.input + totalUsage.output : 0}
          maxTokens={200000}
        />

        {/* Messages 区域 */}
        <Box flexDirection="column" flexGrow={1} paddingX={1} overflow="hidden">
          {messages.length === 0 && !streamingText ? (
            <Text dimColor>Type a message to get started...</Text>
          ) : (
            <>
              {messages.map(msg => (
                <MessageRow key={msg.id} message={msg} />
              ))}
              {/* 流式文本预览 */}
              {streamingText && (
                <MessageRow
                  message={{
                    id: 'streaming',
                    role: 'assistant',
                    content: streamingText,
                    isStreaming: true,
                  }}
                />
              )}
            </>
          )}
        </Box>

        {/* Spinner */}
        {isRunning && !streamingText && (
          <Box paddingX={1}>
            <SpinnerWithVerb
              mode="thinking"
              responseLengthRef={responseLengthRef}
            />
          </Box>
        )}

        {/* 权限对话框 */}
        {pendingPermission && (
          <Box paddingX={1}>
            <PermissionDialog
              title="Permission Required"
              subtitle={pendingPermission.toolName}
              onCancel={() => {
                pendingPermission.resolve(false)
                setAppState(prev => ({ ...prev, pendingPermission: null }))
              }}
              onApprove={() => {
                pendingPermission.resolve(true)
                setAppState(prev => ({ ...prev, pendingPermission: null }))
              }}
            >
              <ToolPermissionCard
                toolName={pendingPermission.toolName}
                input={pendingPermission.input}
                riskLevel={pendingPermission.riskLevel}
              />
            </PermissionDialog>
          </Box>
        )}

        {/* 设置屏幕 */}
        {settingsOpen && <SettingsScreen onClose={() => setSettingsOpen(false)} />}

        {/* 帮助屏幕 */}
        {helpOpen && <HelpScreen onClose={() => setHelpOpen(false)} />}

        {/* Input 区域 */}
        <Divider />
        <PromptInput
          onSubmit={handleSubmit}
          isRunning={isRunning || !!pendingPermission}
          onCancel={handleCancel}
        />
        <Footer
          isRunning={isRunning}
          pendingPermission={!!pendingPermission}
        />
      </Box>
    </OverlayProvider>
  )
}
