import { useState, useCallback, useRef, useEffect } from 'react'
import { useInput as useInkInput, type Key } from 'ink'
import { DoubleTapDetector } from '../utils/doubleTapDetector.js'
import { loadKeybindingsConfig } from '../../config/keybindings.js'

export interface KeyboardShortcutOptions {
  onSubmit: (text: string) => void
  onInterrupt: () => void
  onExit: () => void
  onEnterRestoreMode: () => void
  onCyclePermissionMode: () => void
  isStreaming: boolean
  isRestoreMode: boolean
  isPermissionVisible: boolean
  doubleTapWindowMs?: number
}

/**
 * Pure helper deciding whether the global TUI shortcut handler should ignore
 * the current key event. When the permission dialog or restore-mode overlay
 * is on screen, those components own the keyboard and the input box must not
 * absorb keystrokes.
 *
 * Exposed for unit testing in `test/useKeyboardShortcuts.permission.test.ts`.
 */
export function shouldIgnoreShortcutInput(state: {
  isPermissionVisible: boolean
  isRestoreMode: boolean
}): boolean {
  return state.isPermissionVisible || state.isRestoreMode
}

export function isPermissionModeCycleKey(key: Key): boolean {
  return key.tab === true && key.shift === true
}

export interface KeyboardShortcutState {
  text: string
  cursorPos: number
  hintMessage: string | null
  setText: (text: string) => void
  setCursorPos: (pos: number) => void
}

const HINT_TIMEOUT_MS = 5000

export function useKeyboardShortcuts(options: KeyboardShortcutOptions): KeyboardShortcutState {
  const {
    onSubmit,
    onInterrupt,
    onExit,
    onEnterRestoreMode,
    onCyclePermissionMode,
    isStreaming,
    isRestoreMode,
    isPermissionVisible,
  } = options

  const [text, setText] = useState('')
  const [cursorPos, setCursorPos] = useState(0)
  const [hintMessage, setHintMessage] = useState<string | null>(null)

  const hintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const escapeDetectorRef = useRef<DoubleTapDetector | null>(null)
  const ctrlCDetectorRef = useRef<DoubleTapDetector | null>(null)

  // Load doubleTapWindow from keybindings config on mount
  useEffect(() => {
    const configWindowMs = options.doubleTapWindowMs ?? loadKeybindingsConfig(process.cwd()).doubleTapWindow

    escapeDetectorRef.current = new DoubleTapDetector({ windowMs: configWindowMs })
    ctrlCDetectorRef.current = new DoubleTapDetector({ windowMs: configWindowMs })

    return () => {
      escapeDetectorRef.current?.dispose()
      ctrlCDetectorRef.current?.dispose()
      if (hintTimerRef.current) {
        clearTimeout(hintTimerRef.current)
      }
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const clearHint = useCallback(() => {
    setHintMessage(null)
    if (hintTimerRef.current) {
      clearTimeout(hintTimerRef.current)
      hintTimerRef.current = null
    }
  }, [])

  const showHint = useCallback((message: string) => {
    setHintMessage(message)
    if (hintTimerRef.current) {
      clearTimeout(hintTimerRef.current)
    }
    hintTimerRef.current = setTimeout(() => {
      setHintMessage(null)
      hintTimerRef.current = null
    }, HINT_TIMEOUT_MS)
  }, [])

  const handleInput = useCallback(
    (input: string, key: Key) => {
      // Don't handle input while a modal overlay (restore mode or permission
      // dialog) is on screen — those components own their own keyboard input.
      if (shouldIgnoreShortcutInput({ isPermissionVisible, isRestoreMode })) return

      // Clear hint on any key press
      if (hintMessage) {
        clearHint()
      }

      // --- Shift+Tab: cycle permission mode ---
      if (isPermissionModeCycleKey(key)) {
        onCyclePermissionMode()
        return
      }

      // --- Escape key ---
      if (key.escape) {
        // When streaming: immediately interrupt (no double-tap wait)
        if (isStreaming) {
          onInterrupt()
          return
        }

        // When idle: use double-tap detection
        const result = escapeDetectorRef.current?.tap('escape', () => {
          // Single-tap callback (fires after window expires): clear input text
          setText('')
          setCursorPos(0)
        })

        if (result === 'double') {
          // Double-tap: enter restore mode
          onEnterRestoreMode()
        }
        return
      }

      // --- Ctrl+C ---
      if (key.ctrl && input === 'c') {
        // When streaming: immediately interrupt (no double-tap wait)
        if (isStreaming) {
          onInterrupt()
          return
        }

        // When idle: use double-tap detection
        const currentText = text
        const result = ctrlCDetectorRef.current?.tap('ctrl+c', () => {
          // Single-tap callback (fires after window expires)
          if (currentText === '') {
            // Empty input: show hint
            showHint('Press Ctrl+C again to exit')
          } else {
            // Non-empty input: clear text
            setText('')
            setCursorPos(0)
          }
        })

        if (result === 'double') {
          // Double-tap: exit application
          onExit()
        }
        return
      }

      // --- Enter: submit ---
      if (key.return) {
        const trimmed = text.trim()
        if (trimmed) {
          onSubmit(trimmed)
          setText('')
          setCursorPos(0)
        }
        return
      }

      // --- Left arrow ---
      if (key.leftArrow) {
        setCursorPos((p) => Math.max(0, p - 1))
        return
      }

      // --- Right arrow ---
      if (key.rightArrow) {
        setCursorPos((p) => Math.min(text.length, p + 1))
        return
      }

      // --- Home (Ctrl+A) ---
      if (key.ctrl && input === 'a') {
        setCursorPos(0)
        return
      }

      // --- End (Ctrl+E) ---
      if (key.ctrl && input === 'e') {
        setCursorPos(text.length)
        return
      }

      // --- Ctrl+U: clear to start ---
      if (key.ctrl && input === 'u') {
        setText(text.slice(cursorPos))
        setCursorPos(0)
        return
      }

      // --- Ctrl+K: clear to end ---
      if (key.ctrl && input === 'k') {
        setText(text.slice(0, cursorPos))
        return
      }

      // --- Ctrl+W: delete word backward ---
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

      // --- Backspace ---
      if (key.backspace) {
        if (cursorPos > 0) {
          setText(text.slice(0, cursorPos - 1) + text.slice(cursorPos))
          setCursorPos(cursorPos - 1)
        }
        return
      }

      // --- Delete ---
      if (key.delete) {
        if (cursorPos < text.length) {
          setText(text.slice(0, cursorPos) + text.slice(cursorPos + 1))
        }
        return
      }

      // --- Regular character input ---
      if (input && !key.ctrl && !key.meta) {
        setText(text.slice(0, cursorPos) + input + text.slice(cursorPos))
        setCursorPos(cursorPos + input.length)
      }
    },
    [text, cursorPos, isStreaming, isRestoreMode, isPermissionVisible, hintMessage, onSubmit, onInterrupt, onExit, onEnterRestoreMode, onCyclePermissionMode, clearHint, showHint],
  )

  useInkInput(handleInput, { isActive: !shouldIgnoreShortcutInput({ isPermissionVisible, isRestoreMode }) })

  return { text, cursorPos, hintMessage, setText, setCursorPos }
}
