import React, { useState, useRef, useCallback } from 'react'
import { Box, Text, useInput, useApp } from 'ink'
import { useFileCompletion } from '../hooks/useFileCompletion.js'

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

  useInput((inputChar, key) => {
    // Tab — 文件路径补全
    if (key.tab) {
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

  return (
    <Box paddingX={1}>
      <Text color="cyan" bold>{'> '}</Text>
      {input ? (
        <Text>{input}</Text>
      ) : (
        <Text dimColor>{placeholder || 'Type a message...'}</Text>
      )}
      <Text inverse>{' '}</Text>
    </Box>
  )
}
