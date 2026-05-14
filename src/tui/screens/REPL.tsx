// 主 REPL 屏幕骨架 — Phase 1 使用简单文本列表

import React, { useState, useRef } from 'react'
import { Box, Text } from '../ink.js'
import { useInput, useApp } from 'ink'
import { Divider } from '../design-system/Divider.js'
import { OverlayProvider } from '../context/overlayContext.js'

type Message = {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
}

export function REPL() {
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const { exit } = useApp()
  const nextId = useRef(0)

  useInput((inputChar, key) => {
    // Ctrl+C
    if (key.ctrl && inputChar === 'c') return
    // Ctrl+D — 退出
    if (key.ctrl && inputChar === 'd') {
      exit()
      return
    }
    // Ctrl+L — 清屏
    if (key.ctrl && inputChar === 'l') {
      console.clear()
      return
    }
    // Enter — 提交
    if (key.return) {
      if (input.trim()) {
        const userMsg: Message = { id: `msg-${nextId.current++}`, role: 'user', content: input }
        setMessages(prev => [...prev, userMsg])
        const assistantMsg: Message = {
          id: `msg-${nextId.current++}`,
          role: 'assistant',
          content: `Echo: ${input}`,
        }
        setMessages(prev => [...prev, assistantMsg])
        setInput('')
      }
      return
    }
    // Backspace
    if (key.backspace || key.delete) {
      setInput(prev => prev.slice(0, -1))
      return
    }
    // 普通字符
    if (inputChar && !key.ctrl && !key.meta) {
      setInput(prev => prev + inputChar)
    }
  })

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
              <Box key={msg.id} marginBottom={1}>
                <Text bold color={msg.role === 'user' ? 'blue' : 'green'}>
                  {msg.role === 'user' ? '> ' : '< '}
                </Text>
                <Text>{msg.content}</Text>
              </Box>
            ))
          )}
        </Box>

        {/* Input 区域 */}
        <Divider />
        <Box paddingX={1}>
          <Text color="cyan">{'> '}</Text>
          <Text>{input}</Text>
          <Text inverse>{' '}</Text>
        </Box>
      </Box>
    </OverlayProvider>
  )
}
