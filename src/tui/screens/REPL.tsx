// 主 REPL 屏幕 — 集成 AgentLoop 流式输出

import React, { useState, useRef, useCallback } from 'react'
import { Box, Text } from '../ink.js'
import { useApp } from 'ink'
import { Divider } from '../design-system/Divider.js'
import { OverlayProvider } from '../context/overlayContext.js'
import { MessageRow } from '../components/messages/MessageRow.js'
import { SpinnerWithVerb } from '../components/Spinner/SpinnerWithVerb.js'
import { PromptInput } from '../components/PromptInput.js'
import { PermissionDialog } from '../components/permissions/PermissionDialog.js'
import { ToolPermissionCard } from '../components/permissions/ToolPermissionCard.js'
import { useAppState, useSetAppState } from '../state/AppState.js'
import type { ChatMessage } from '../components/messages/types.js'
import type { AgentLoop } from '../../harness/loop.js'
import type { AgentStreamEvent } from '../../harness/types.js'
import type { Store } from '../state/store.js'
import type { AppState } from '../state/AppStateStore.js'

type REPLProps = {
  loop?: AgentLoop
  session?: { id: string; shortId?: string }
  appStore?: Store<AppState>
}

export function REPL({ loop, session, appStore }: REPLProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [isRunning, setIsRunning] = useState(false)
  const [streamingText, setStreamingText] = useState('')
  const { exit } = useApp()
  const nextId = useRef(0)
  const responseLengthRef = useRef(0)
  const abortRef = useRef<AbortController | null>(null)

  const pendingPermission = useAppState(s => s.pendingPermission)
  const setAppState = useSetAppState()

  const handleSubmit = useCallback(async (text: string) => {
    // 添加用户消息
    const userMsg: ChatMessage = {
      id: `msg-${nextId.current++}`,
      role: 'user',
      content: text,
      timestamp: Date.now(),
    }
    setMessages(prev => [...prev, userMsg])
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
        <Box paddingX={1}>
          <Text bold color="cyan">myagent</Text>
          <Text dimColor> — TUI Mode</Text>
          {session && <Text dimColor> [{session.shortId ?? session.id.slice(0, 8)}]</Text>}
        </Box>
        <Divider />

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

        {/* Input 区域 */}
        <Divider />
        <PromptInput
          onSubmit={handleSubmit}
          isRunning={isRunning || !!pendingPermission}
          onCancel={handleCancel}
        />
      </Box>
    </OverlayProvider>
  )
}
