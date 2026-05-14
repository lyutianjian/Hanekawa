import { Box, Text, useInput, useApp, useCursor } from 'ink'
import { useState, useCallback, useEffect, useRef } from 'react'
import stringWidth from 'string-width'
import { ThemedText } from '../design-system/ThemedText.js'
import { useKeyBindings } from '../keybindings/useKeyBindings.js'
import { useTypeahead } from '../typeahead/useTypeahead.js'
import { TypeaheadPopup } from '../typeahead/TypeaheadPopup.js'

interface PromptInputProps {
  onSubmit: (text: string) => void
  isDisabled?: boolean
  cursorY: number
  cwd: string
}

export function PromptInput({ onSubmit, isDisabled, cursorY, cwd }: PromptInputProps) {
  const [input, setInput] = useState('')
  const [history, setHistory] = useState<string[]>([])
  const [historyIndex, setHistoryIndex] = useState(-1)
  const { exit } = useApp()
  const { setCursorPosition } = useCursor()
  const { suggestions, selectedIndex, isOpen, acceptSuggestion, navigateUp, navigateDown, close } = useTypeahead(input, cwd)

  // Use ref to store latest input value, avoiding React state update delay
  const inputRef = useRef('')

  // Set cursor position during render so it's available before onRender writes output.
  // setCursorPosition only stores a value (no React state update), safe to call here.
  if (isDisabled) {
    setCursorPosition(undefined)
  } else {
    // 1(paddingLeft) + 2('> ') + input width + 1(cursor after last char)
    const x = 3 + stringWidth(inputRef.current) + 1
    setCursorPosition({ x, y: cursorY })
  }

  // Sync ref with input state (for external updates like history restore)
  useEffect(() => {
    inputRef.current = input
  }, [input])

  // Hide cursor on unmount
  useEffect(() => {
    return () => setCursorPosition(undefined)
  }, [setCursorPosition])

  const handleSubmit = useCallback(() => {
    const trimmed = input.trim()
    if (!trimmed) return

    if (trimmed === '/exit' || trimmed === 'exit') {
      exit()
      return
    }

    setHistory((prev) => [trimmed, ...prev].slice(0, 1000))
    setHistoryIndex(-1)

    onSubmit(trimmed)
    setInput('')
    inputRef.current = ''
  }, [input, onSubmit, exit])

  useInput((inputChar, key) => {
    if (isDisabled) return

    // Handle Tab for autocomplete
    if (key.tab && isOpen) {
      const value = acceptSuggestion()
      if (value) {
        setInput(value)
        inputRef.current = value
      }
      return
    }

    // Handle arrow keys for suggestion navigation when open
    if (isOpen) {
      if (key.upArrow) {
        navigateUp()
        return
      }
      if (key.downArrow) {
        navigateDown()
        return
      }
    }

    if (key.return) {
      // If suggestions are open, accept the selected one
      if (isOpen) {
        const value = acceptSuggestion()
        if (value) {
          setInput(value)
          inputRef.current = value
          return
        }
      }

      // Shift+Enter or Ctrl+Enter inserts newline instead of submitting
      if (key.shift || key.ctrl) {
        setInput((prev) => {
          const newInput = prev + '\n'
          inputRef.current = newInput
          return newInput
        })
        return
      }
      handleSubmit()
      return
    }

    if (key.escape) {
      if (isOpen) {
        close()
        return
      }
      setInput('')
      inputRef.current = ''
      setHistoryIndex(-1)
      return
    }

    if (key.upArrow) {
      if (history.length === 0) return
      const newIndex = Math.min(historyIndex + 1, history.length - 1)
      setHistoryIndex(newIndex)
      const newInput = history[newIndex] ?? ''
      setInput(newInput)
      inputRef.current = newInput
      return
    }

    if (key.downArrow) {
      if (historyIndex <= 0) {
        setHistoryIndex(-1)
        setInput('')
        inputRef.current = ''
        return
      }
      const newIndex = historyIndex - 1
      setHistoryIndex(newIndex)
      const newInput = history[newIndex] ?? ''
      setInput(newInput)
      inputRef.current = newInput
      return
    }

    if (key.backspace || key.delete) {
      setInput((prev) => {
        const newInput = prev.slice(0, -1)
        inputRef.current = newInput
        return newInput
      })
      return
    }

    if (inputChar && !key.ctrl && !key.meta) {
      setInput((prev) => {
        const newInput = prev + inputChar
        inputRef.current = newInput
        return newInput
      })
    }
  })

  // Text editing keybindings
  useKeyBindings('chat', {
    'line-start': () => {
      // Move cursor to start - handled by terminal
    },
    'line-end': () => {
      // Move cursor to end - handled by terminal
    },
    'kill-line': () => {
      setInput('')
      inputRef.current = ''
    },
    'kill-line-backward': () => {
      setInput('')
      inputRef.current = ''
    },
    'kill-word': () => {
      setInput((prev) => {
        const words = prev.trimEnd().split(/\s+/)
        words.pop()
        const newInput = words.join(' ')
        inputRef.current = newInput
        return newInput
      })
    },
  })

  const lines = input.split('\n')

  return (
    <Box flexDirection="column" paddingX={1}>
      {isOpen && (
        <TypeaheadPopup
          suggestions={suggestions}
          selectedIndex={selectedIndex}
          onSelect={(suggestion) => {
            setInput(suggestion.value)
            inputRef.current = suggestion.value
          }}
        />
      )}
      {lines.map((line, i) => (
        <Box key={i} flexDirection="row">
          <ThemedText color="prompt" bold>{i === 0 ? '> ' : '. '}</ThemedText>
          <ThemedText color="userMessage">{line}</ThemedText>
        </Box>
      ))}
    </Box>
  )
}
