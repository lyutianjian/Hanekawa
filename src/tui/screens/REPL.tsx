// 主 REPL 屏幕 — 集成消息系统、Spinner、输入组件

import React, { useState, useRef, useCallback } from 'react'
import { Box, Text } from '../ink.js'
import { useApp } from 'ink'
import { Divider } from '../design-system/Divider.js'
import { OverlayProvider } from '../context/overlayContext.js'
import { MessageRow } from '../components/messages/MessageRow.js'
import { SpinnerWithVerb } from '../components/Spinner/SpinnerWithVerb.js'
import { PromptInput } from '../components/PromptInput.js'
import type { ChatMessage } from '../components/messages/types.js'

export function REPL() {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [isRunning, setIsRunning] = useState(false)
  const { exit } = useApp()
  const nextId = useRef(0)
  const responseLengthRef = useRef(0)

  const handleSubmit = useCallback((text: string) => {
    // 添加用户消息
    const userMsg: ChatMessage = {
      id: `msg-${nextId.current++}`,
      role: 'user',
      content: text,
      timestamp: Date.now(),
    }
    setMessages(prev => [...prev, userMsg])

    // 模拟 agent 处理（Phase 1: echo，后续接入 AgentLoop）
    setIsRunning(true)
    responseLengthRef.current = 0

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
  }, [])

  const handleCancel = useCallback(() => {
    setIsRunning(false)
  }, [])

  return (
    <OverlayProvider>
      <Box flexDirection="column" height="100%">
        {/* Header */}
        <Box paddingX={1}>
          <Text bold color="cyan">myagent</Text>
          <Text dimColor> — TUI Mode</Text>
        </Box>
        <Divider />

        {/* Messages 区域 */}
        <Box flexDirection="column" flexGrow={1} paddingX={1} overflow="hidden">
          {messages.length === 0 ? (
            <Text dimColor>Type a message to get started...</Text>
          ) : (
            messages.map(msg => (
              <MessageRow key={msg.id} message={msg} />
            ))
          )}
        </Box>

        {/* Spinner */}
        {isRunning && (
          <Box paddingX={1}>
            <SpinnerWithVerb
              mode="thinking"
              responseLengthRef={responseLengthRef}
            />
          </Box>
        )}

        {/* Input 区域 */}
        <Divider />
        <PromptInput
          onSubmit={handleSubmit}
          isRunning={isRunning}
          onCancel={handleCancel}
        />
      </Box>
    </OverlayProvider>
  )
}
