import { useState, useCallback, useRef, useEffect } from 'react'
import { useInput as useInkInput, type Key } from 'ink'
import { DoubleTapDetector } from '../utils/doubleTapDetector.js'
import { loadKeybindingsConfig } from '../../config/keybindings.js'
import { listCommands } from '../../commands/index.js'
import {
  applyCommandSuggestion,
  generateCommandSuggestions,
  type CommandSuggestion,
} from '../suggestions/commandSuggestions.js'
import {
  applyFileSuggestion,
  generateFileSuggestions,
  type FileSuggestion,
} from '../suggestions/fileSuggestions.js'
import type { SuggestionItem, SuggestionType } from '../suggestions/types.js'

export interface KeyboardShortcutOptions {
  onSubmit: (text: string) => void
  onInterrupt: () => void
  onExit: () => void
  onEnterRestoreMode: () => void
  onCyclePermissionMode: (direction: 1 | -1) => void
  isStreaming: boolean
  isRestoreMode: boolean
  isPermissionVisible: boolean
  cwd?: string
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

export function permissionModeCycleDirection(_key: Key): 1 | -1 {
  return 1
}

export interface KeyboardShortcutState {
  text: string
  cursorPos: number
  hintMessage: string | null
  suggestions: SuggestionItem[]
  selectedSuggestion: number
  suggestionType: SuggestionType
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
    cwd = process.cwd(),
  } = options

  const [text, setText] = useState('')
  const [cursorPos, setCursorPos] = useState(0)
  const [hintMessage, setHintMessage] = useState<string | null>(null)
  const [suggestions, setSuggestions] = useState<SuggestionItem[]>([])
  const [selectedSuggestion, setSelectedSuggestion] = useState(-1)
  const [suggestionType, setSuggestionType] = useState<SuggestionType>('none')

  const hintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const escapeDetectorRef = useRef<DoubleTapDetector | null>(null)
  const escapeClearDetectorRef = useRef<DoubleTapDetector | null>(null)
  const ctrlCDetectorRef = useRef<DoubleTapDetector | null>(null)
  const doubleTapWindowMsRef = useRef(options.doubleTapWindowMs ?? 300)
  const suggestionRequestRef = useRef(0)

  // Load doubleTapWindow from keybindings config on mount
  useEffect(() => {
    const configWindowMs = options.doubleTapWindowMs ?? loadKeybindingsConfig(process.cwd()).doubleTapWindow
    doubleTapWindowMsRef.current = configWindowMs

    escapeDetectorRef.current = new DoubleTapDetector({ windowMs: configWindowMs })
    escapeClearDetectorRef.current = new DoubleTapDetector({ windowMs: configWindowMs })
    ctrlCDetectorRef.current = new DoubleTapDetector({ windowMs: configWindowMs })

    return () => {
      escapeDetectorRef.current?.dispose()
      escapeClearDetectorRef.current?.dispose()
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

  const clearSuggestions = useCallback(() => {
    setSuggestions([])
    setSelectedSuggestion(-1)
    setSuggestionType('none')
  }, [])

  const refreshSuggestions = useCallback(async (value: string, valueCursorPos: number) => {
    const requestId = ++suggestionRequestRef.current
    if (isStreaming || shouldIgnoreShortcutInput({ isPermissionVisible, isRestoreMode })) {
      clearSuggestions()
      return
    }

    const commandSuggestions = generateCommandSuggestions(value, listCommands())
    const nextType: SuggestionType = commandSuggestions.length > 0 ? 'command' : 'file'
    const nextSuggestions = commandSuggestions.length > 0
      ? commandSuggestions
      : await generateFileSuggestions(value, valueCursorPos, cwd)

    if (requestId !== suggestionRequestRef.current) return
    setSuggestions(nextSuggestions)
    setSelectedSuggestion((current) => {
      if (nextSuggestions.length === 0) return -1
      if (current < 0) return 0
      return Math.min(current, nextSuggestions.length - 1)
    })
    setSuggestionType(nextSuggestions.length > 0 ? nextType : 'none')
  }, [clearSuggestions, cwd, isPermissionVisible, isRestoreMode, isStreaming])

  useEffect(() => {
    void refreshSuggestions(text, cursorPos)
  }, [text, cursorPos, refreshSuggestions])

  const handleInput = useCallback(
    (input: string, key: Key) => {
      // Don't handle input while a modal overlay (restore mode or permission
      // dialog) is on screen; those components own their keyboard input.
      if (shouldIgnoreShortcutInput({ isPermissionVisible, isRestoreMode })) return

      if (hintMessage) {
        clearHint()
      }

      // --- Shift+Tab: cycle permission mode ---
      if (isPermissionModeCycleKey(key)) {
        onCyclePermissionMode(permissionModeCycleDirection(key))
        return
      }

      const hasActiveSuggestion = suggestionType !== 'none' && suggestions.length > 0

      if (hasActiveSuggestion && key.escape && !isStreaming) {
        clearSuggestions()
        return
      }

      if (hasActiveSuggestion && key.upArrow) {
        setSelectedSuggestion((current) => (
          current <= 0 ? suggestions.length - 1 : current - 1
        ))
        return
      }

      if (hasActiveSuggestion && key.downArrow) {
        setSelectedSuggestion((current) => (
          current >= suggestions.length - 1 ? 0 : current + 1
        ))
        return
      }

      if (hasActiveSuggestion && key.tab) {
        const suggestion = suggestions[selectedSuggestion < 0 ? 0 : selectedSuggestion]
        if (suggestion && suggestionType === 'command') {
          const applied = applyCommandSuggestion(suggestion as CommandSuggestion)
          setText(applied.text)
          setCursorPos(applied.cursorPos)
          clearSuggestions()
        }
        if (suggestion && suggestionType === 'file') {
          const applied = applyFileSuggestion(text, cursorPos, suggestion as FileSuggestion)
          setText(applied.text)
          setCursorPos(applied.cursorPos)
          clearSuggestions()
        }
        return
      }

      if (hasActiveSuggestion && key.return) {
        const suggestion = suggestions[selectedSuggestion < 0 ? 0 : selectedSuggestion]
        if (suggestion && suggestionType === 'command') {
          const applied = applyCommandSuggestion(suggestion as CommandSuggestion)
          onSubmit(applied.text.trim())
          setText('')
          setCursorPos(0)
          clearSuggestions()
        }
        if (suggestion && suggestionType === 'file') {
          const applied = applyFileSuggestion(text, cursorPos, suggestion as FileSuggestion)
          setText(applied.text)
          setCursorPos(applied.cursorPos)
          clearSuggestions()
        }
        return
      }

      // Plain Tab is reserved for autocomplete and should not insert a
      // literal tab into the prompt.
      if (key.tab) {
        return
      }

      // --- Escape key ---
      if (key.escape) {
        if (isStreaming) {
          onInterrupt()
          return
        }

        if (text.length > 0) {
          // Input has content: use the dedicated clear detector.
          // Cancel the rewind detector so prior empty-state taps don't
          // carry over into the clear path.
          escapeDetectorRef.current?.cancel()
          const result = escapeClearDetectorRef.current?.tap('escape-clear', () => {})
          if (result === 'double') {
            setText('')
            setCursorPos(0)
            clearSuggestions()
          }
          return
        }

        // Input is empty: use the rewind detector.
        // Cancel the clear detector so prior content-state taps don't
        // carry over into the rewind path.
        escapeClearDetectorRef.current?.cancel()
        const result = escapeDetectorRef.current?.tap('escape-rewind', () => {})
        if (result === 'double') {
          onEnterRestoreMode()
          return
        }
        return
      }

      // --- Ctrl+C ---
      if (key.ctrl && input === 'c') {
        if (!isStreaming && text.length > 0) {
          ctrlCDetectorRef.current?.cancel()
          setText('')
          setCursorPos(0)
          clearSuggestions()
          showHint('Input cleared. Press Ctrl+C twice to exit')
          return
        }

        const result = ctrlCDetectorRef.current?.tap('ctrl+c', () => {})
        if (result === 'double') {
          onExit()
          return
        }

        if (isStreaming) {
          onInterrupt()
          showHint('Press Ctrl+C again to exit')
          return
        }

        if (!isStreaming) {
          setText('')
          setCursorPos(0)
          clearSuggestions()
          showHint('Press Ctrl+C again to exit')
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
          clearSuggestions()
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
    [text, cursorPos, isStreaming, isRestoreMode, isPermissionVisible, hintMessage, onSubmit, onInterrupt, onExit, onEnterRestoreMode, onCyclePermissionMode, clearHint, showHint, suggestionType, suggestions, selectedSuggestion, clearSuggestions],
  )

  useInkInput(handleInput, { isActive: !shouldIgnoreShortcutInput({ isPermissionVisible, isRestoreMode }) })

  return {
    text,
    cursorPos,
    hintMessage,
    suggestions,
    selectedSuggestion,
    suggestionType,
    setText,
    setCursorPos,
  }
}
