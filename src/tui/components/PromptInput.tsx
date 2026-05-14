import React, { useState, useRef, useCallback } from 'react'
import { Box, Text, useInput, useApp } from 'ink'
import { useFileCompletion } from '../hooks/useFileCompletion.js'
import { useSlashCompletion } from '../hooks/useSlashCompletion.js'
import { Divider } from '../design-system/Divider.js'

type Props = {
  onSubmit: (text: string) => void
  isRunning: boolean
  onCancel?: () => void
  placeholder?: string
}

export function PromptInput({ onSubmit, isRunning, onCancel, placeholder }: Props) {
  const [input, setInput] = useState('')
  const [historyIndex, setHistoryIndex] = useState(-1)
  const historyRef = useRef<string[]>([])
  const { exit } = useApp()
  const cwd = process.cwd()
  const { complete } = useFileCompletion(cwd)
  const { suggestions, selectedIndex, setSelectedIndex, accept } = useSlashCompletion(input)

  useInput((inputChar, key) => {
    // Tab — slash 命令补全优先，否则文件路径补全
    if (key.tab) {
      if (suggestions.length > 0) {
        const completed = accept(selectedIndex)
        if (completed) setInput(completed)
        return
      }
      complete(input).then(completed => {
        if (completed) {
          setInput(completed)
        }
      })
      return
    }
    // Ctrl+C — 取消或退出
    if (key.ctrl && inputChar === 'c') {
      if (isRunning && onCancel) {
        onCancel()
      }
      return
    }

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

    // Shift+Enter 或 Alt+Enter — 插入换行
    if ((key.shift && key.return) || (key.meta && key.return)) {
      setInput(prev => prev + '\n')
      return
    }

    // Enter — 提交
    if (key.return) {
      if (input.trim() && !isRunning) {
        historyRef.current.unshift(input)
        if (historyRef.current.length > 100) historyRef.current.pop()
        onSubmit(input)
        setInput('')
        setHistoryIndex(-1)
      }
      return
    }

    // Up — 历史上一个
    if (key.upArrow) {
      const history = historyRef.current
      if (history.length > 0) {
        const newIndex = Math.min(historyIndex + 1, history.length - 1)
        setHistoryIndex(newIndex)
        setInput(history[newIndex])
      }
      return
    }

    // Down — 历史下一个
    if (key.downArrow) {
      if (historyIndex > 0) {
        const newIndex = historyIndex - 1
        setHistoryIndex(newIndex)
        setInput(historyRef.current[newIndex])
      } else {
        setHistoryIndex(-1)
        setInput('')
      }
      return
    }

    // Backspace
    if (key.backspace || key.delete) {
      setInput(prev => prev.slice(0, -1))
      return
    }

    // Ctrl+A — 行首
    if (key.ctrl && inputChar === 'a') {
      // Ink 不支持光标移动，简化处理
      return
    }

    // Ctrl+U — 清除当前行
    if (key.ctrl && inputChar === 'u') {
      setInput('')
      return
    }

    // 普通字符
    if (inputChar && !key.ctrl && !key.meta) {
      setInput(prev => prev + inputChar)
    }
  })

  const inputLines = input.split('\n')
  const displayInput = inputLines.map((line, i) => (
    <React.Fragment key={i}>
      {i === 0 ? <Text color="cyan" bold>{'> '}</Text> : <Text color="cyan">{'  '}</Text>}
      <Text>{line}</Text>
      {'\n'}
    </React.Fragment>
  ))

  return (
    <Box flexDirection="column">
      <Divider />
      <Box paddingX={1}>
        {input ? (
          displayInput
        ) : (
          <Box>
            <Text color="cyan" bold>{'> '}</Text>
            <Text dimColor>{placeholder || 'Type a message...'}</Text>
          </Box>
        )}
      </Box>
      {suggestions.length > 0 && input.startsWith('/') && (
        <Box paddingX={2}>
          <Text dimColor>Tab: </Text>
          {suggestions.slice(0, 5).map((cmd, i) => (
            <Text key={cmd} color={i === selectedIndex ? 'cyan' : undefined}>
              {cmd}{' '}
            </Text>
          ))}
        </Box>
      )}
      {inputLines.length > 1 && (
        <Box paddingX={2}>
          <Text dimColor>Shift+Enter for newline · Enter to send ({inputLines.length} lines)</Text>
        </Box>
      )}
      <Text inverse>{' '}</Text>
    </Box>
  )
}
