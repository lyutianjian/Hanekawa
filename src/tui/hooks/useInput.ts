import { useState, useCallback, useRef } from 'react'
import { useInput as useInkInput, type Key } from 'ink'

interface UseInputOptions {
  onSubmit: (text: string) => void
  onInterrupt: () => void
  disabled?: boolean
  history?: string[]
}

export function useInput({ onSubmit, onInterrupt, disabled = false, history = [] }: UseInputOptions) {
  const [text, setText] = useState('')
  const [cursorPos, setCursorPos] = useState(0)
  const [historyIndex, setHistoryIndex] = useState(-1)
  const savedTextRef = useRef('')

  const handleInput = useCallback(
    (input: string, key: Key) => {
      if (disabled) return

      // Ctrl+C: interrupt if empty, clear if not
      if (key.ctrl && input === 'c') {
        if (text === '') {
          onInterrupt()
        } else {
          setText('')
          setCursorPos(0)
          setHistoryIndex(-1)
        }
        return
      }

      // Enter: submit
      if (key.return) {
        const trimmed = text.trim()
        if (trimmed) {
          onSubmit(trimmed)
          setText('')
          setCursorPos(0)
          setHistoryIndex(-1)
        }
        return
      }

      // Left arrow
      if (key.leftArrow) {
        setCursorPos((p) => Math.max(0, p - 1))
        return
      }

      // Right arrow
      if (key.rightArrow) {
        setCursorPos((p) => Math.min(text.length, p + 1))
        return
      }

      // Home (Ctrl+A)
      if (key.ctrl && input === 'a') {
        setCursorPos(0)
        return
      }

      // End (Ctrl+E)
      if (key.ctrl && input === 'e') {
        setCursorPos(text.length)
        return
      }

      // Ctrl+U: clear to start
      if (key.ctrl && input === 'u') {
        setText(text.slice(cursorPos))
        setCursorPos(0)
        return
      }

      // Ctrl+K: clear to end
      if (key.ctrl && input === 'k') {
        setText(text.slice(0, cursorPos))
        return
      }

      // Ctrl+W: delete word backward
      if (key.ctrl && input === 'w') {
        const before = text.slice(0, cursorPos)
        const after = text.slice(cursorPos)
        const trimmed = before.trimEnd()
        const lastSpace = trimmed.lastIndexOf(' ')
        const newText = (lastSpace >= 0 ? trimmed.slice(0, lastSpace + 1) : '') + after
        const newCursor = lastSpace >= 0 ? lastSpace + 1 : 0
        setText(newText)
        setCursorPos(newCursor)
        return
      }

      // Up arrow: history
      if (key.upArrow && history.length > 0) {
        const newIndex = historyIndex < 0 ? history.length - 1 : Math.max(0, historyIndex - 1)
        if (historyIndex < 0) savedTextRef.current = text
        setHistoryIndex(newIndex)
        setText(history[newIndex])
        setCursorPos(history[newIndex].length)
        return
      }

      // Down arrow: history
      if (key.downArrow && history.length > 0) {
        if (historyIndex < 0) return
        const newIndex = historyIndex + 1
        if (newIndex >= history.length) {
          setHistoryIndex(-1)
          setText(savedTextRef.current)
          setCursorPos(savedTextRef.current.length)
        } else {
          setHistoryIndex(newIndex)
          setText(history[newIndex])
          setCursorPos(history[newIndex].length)
        }
        return
      }

      // Escape: clear line
      if (key.escape) {
        setText('')
        setCursorPos(0)
        setHistoryIndex(-1)
        return
      }

      // Backspace
      if (key.backspace) {
        if (cursorPos > 0) {
          setText(text.slice(0, cursorPos - 1) + text.slice(cursorPos))
          setCursorPos(cursorPos - 1)
        }
        return
      }

      // Delete
      if (key.delete) {
        if (cursorPos < text.length) {
          setText(text.slice(0, cursorPos) + text.slice(cursorPos + 1))
        }
        return
      }

      // Regular character input
      if (input && !key.ctrl && !key.meta) {
        setText(text.slice(0, cursorPos) + input + text.slice(cursorPos))
        setCursorPos(cursorPos + input.length)
      }
    },
    [text, cursorPos, historyIndex, history, disabled, onSubmit, onInterrupt],
  )

  useInkInput(handleInput, { isActive: !disabled })

  return { text, cursorPos, setText, setCursorPos }
}
