import { useState, useCallback, useRef, useEffect } from 'react'
import { useInput as useInkInput, type Key } from 'ink'
import { DoubleTapDetector } from '../utils/doubleTapDetector.js'
import { loadKeybindingsConfig } from '../../config/keybindings.js'
import { listCommands } from '../../commands/index.js'
import {
  applyCommandSuggestion,
  generateCommandSuggestions,
  type CommandSuggestion,
} from '../../runtime/suggestions/commandSuggestions.js'
import {
  applyFileSuggestion,
  generateFileSuggestions,
  type FileSuggestion,
} from '../../runtime/suggestions/fileSuggestions.js'
import type { SuggestionItem, SuggestionType } from '../../runtime/suggestions/types.js'

export interface KeyboardShortcutOptions {
  onSubmit: (text: string) => unknown | Promise<unknown>
  onInterrupt: () => void
  onClearQueue?: () => void
  onExit: () => void
  onEnterRestoreMode: () => void
  onCyclePermissionMode: (direction: 1 | -1) => void
  onToggleTranscript: () => void
  isStreaming: boolean
  hasQueuedMessages?: boolean
  isRestoreMode: boolean
  isPermissionVisible: boolean
  cwd?: string
  doubleTapWindowMs?: number
  history?: string[]
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
    onClearQueue = () => {},
    onExit,
    onEnterRestoreMode,
    onCyclePermissionMode,
    onToggleTranscript,
    isStreaming,
    hasQueuedMessages = false,
    isRestoreMode,
    isPermissionVisible,
    cwd = process.cwd(),
    history = [],
  } = options

  const [text, setText] = useState('')
  const [cursorPos, setCursorPos] = useState(0)
  const [hintMessage, setHintMessage] = useState<string | null>(null)
  const [suggestions, setSuggestions] = useState<SuggestionItem[]>([])
  const [selectedSuggestion, setSelectedSuggestion] = useState(-1)
  const [suggestionType, setSuggestionType] = useState<SuggestionType>('none')
  const [historyIndex, setHistoryIndex] = useState(-1)

  const hintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const escapeDetectorRef = useRef<DoubleTapDetector | null>(null)
  const escapeClearDetectorRef = useRef<DoubleTapDetector | null>(null)
  const ctrlCDetectorRef = useRef<DoubleTapDetector | null>(null)
  const streamingEscapeDetectorRef = useRef<DoubleTapDetector | null>(null)
  const submitPendingRef = useRef(false)
  const doubleTapWindowMsRef = useRef(options.doubleTapWindowMs ?? 300)
  const suggestionRequestRef = useRef(0)
  const historyDraftRef = useRef('')

  const leaveHistory = useCallback(() => {
    setHistoryIndex(-1)
  }, [])

  const replaceText = useCallback((value: string) => {
    leaveHistory()
    setText(value)
  }, [leaveHistory])

  const replaceCursorPos = useCallback((value: number) => {
    setCursorPos(value)
  }, [])

  // Load doubleTapWindow from keybindings config on mount
  useEffect(() => {
    const configWindowMs = options.doubleTapWindowMs ?? loadKeybindingsConfig(process.cwd()).doubleTapWindow
    doubleTapWindowMsRef.current = configWindowMs

    escapeDetectorRef.current = new DoubleTapDetector({ windowMs: configWindowMs })
    escapeClearDetectorRef.current = new DoubleTapDetector({ windowMs: configWindowMs })
    ctrlCDetectorRef.current = new DoubleTapDetector({ windowMs: configWindowMs })
    streamingEscapeDetectorRef.current = new DoubleTapDetector({ windowMs: configWindowMs })

    return () => {
      escapeDetectorRef.current?.dispose()
      escapeClearDetectorRef.current?.dispose()
      ctrlCDetectorRef.current?.dispose()
      streamingEscapeDetectorRef.current?.dispose()
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

  const submitInput = useCallback((value: string, originalText: string) => {
    if (submitPendingRef.current) return
    submitPendingRef.current = true
    const finish = (accepted: unknown) => {
      if (accepted === false) return
      setText((current) => {
        if (current !== originalText) return current
        setCursorPos(0)
        leaveHistory()
        clearSuggestions()
        return ''
      })
    }

    let result: unknown
    try {
      result = onSubmit(value)
    } catch {
      // The submitter owns user-visible error reporting. Keep the draft intact.
      submitPendingRef.current = false
      return
    }
    if (isPromiseLike(result)) {
      void result.then(finish).catch(() => {
        // The submitter owns user-visible error reporting. Keep the draft intact.
      }).finally(() => {
        submitPendingRef.current = false
      })
      return
    }
    finish(result)
    submitPendingRef.current = false
  }, [onSubmit, clearSuggestions, leaveHistory])

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

      // --- Ctrl+O: toggle transcript mode ---
      if (key.ctrl && input === 'o') {
        onToggleTranscript()
        return
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
          submitInput(applied.text.trim(), text)
        }
        if (suggestion && suggestionType === 'file') {
          const applied = applyFileSuggestion(text, cursorPos, suggestion as FileSuggestion)
          setText(applied.text)
          setCursorPos(applied.cursorPos)
          clearSuggestions()
        }
        return
      }

      if (!hasActiveSuggestion && key.upArrow && history.length > 0) {
        if (historyIndex < 0) historyDraftRef.current = text
        const nextIndex = historyIndex < 0 ? history.length - 1 : Math.max(0, historyIndex - 1)
        const nextText = history[nextIndex] ?? ''
        setHistoryIndex(nextIndex)
        setText(nextText)
        setCursorPos(nextText.length)
        clearSuggestions()
        return
      }

      if (!hasActiveSuggestion && key.downArrow && historyIndex >= 0) {
        const nextIndex = historyIndex + 1
        if (nextIndex >= history.length) {
          const draft = historyDraftRef.current
          setHistoryIndex(-1)
          setText(draft)
          setCursorPos(draft.length)
        } else {
          const nextText = history[nextIndex] ?? ''
          setHistoryIndex(nextIndex)
          setText(nextText)
          setCursorPos(nextText.length)
        }
        clearSuggestions()
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
          escapeDetectorRef.current?.cancel()
          escapeClearDetectorRef.current?.cancel()
          const result = streamingEscapeDetectorRef.current?.tap('escape-streaming', () => {})
          if (result === 'double') {
            onClearQueue()
            return
          }
          onInterrupt()
          return
        }

        if (hasQueuedMessages) {
          escapeDetectorRef.current?.cancel()
          escapeClearDetectorRef.current?.cancel()
          const result = streamingEscapeDetectorRef.current?.tap('escape-streaming', () => {})
          if (result === 'double') onClearQueue()
          return
        }
        streamingEscapeDetectorRef.current?.cancel()

        if (text.length > 0) {
          // Input has content: use the dedicated clear detector.
          // Cancel the rewind detector so prior empty-state taps don't
          // carry over into the clear path.
          escapeDetectorRef.current?.cancel()
          const result = escapeClearDetectorRef.current?.tap('escape-clear', () => {})
          if (result === 'double') {
            setText('')
            setCursorPos(0)
            leaveHistory()
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
          leaveHistory()
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
          leaveHistory()
          clearSuggestions()
          showHint('Press Ctrl+C again to exit')
        }
        return
      }

      // --- Enter: submit ---
      if (key.return) {
        const trimmed = text.trim()
        if (trimmed) {
          submitInput(trimmed, text)
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
        leaveHistory()
        setText(text.slice(cursorPos))
        setCursorPos(0)
        return
      }

      // --- Ctrl+K: clear to end ---
      if (key.ctrl && input === 'k') {
        leaveHistory()
        setText(text.slice(0, cursorPos))
        return
      }

      // --- Ctrl+W: delete word backward ---
      if (key.ctrl && input === 'w') {
        leaveHistory()
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
        leaveHistory()
        if (cursorPos > 0) {
          setText(text.slice(0, cursorPos - 1) + text.slice(cursorPos))
          setCursorPos(cursorPos - 1)
        }
        return
      }

      // --- Delete ---
      if (key.delete) {
        leaveHistory()
        if (cursorPos < text.length) {
          setText(text.slice(0, cursorPos) + text.slice(cursorPos + 1))
        }
        return
      }

      // --- Regular character input ---
      if (input && !key.ctrl && !key.meta) {
        leaveHistory()
        setText(text.slice(0, cursorPos) + input + text.slice(cursorPos))
        setCursorPos(cursorPos + input.length)
      }
    },
    [text, cursorPos, history, historyIndex, isStreaming, hasQueuedMessages, isRestoreMode, isPermissionVisible, hintMessage, onInterrupt, onClearQueue, onExit, onEnterRestoreMode, onCyclePermissionMode, onToggleTranscript, clearHint, showHint, submitInput, suggestionType, suggestions, selectedSuggestion, clearSuggestions, leaveHistory],
  )

  useInkInput(handleInput, { isActive: !shouldIgnoreShortcutInput({ isPermissionVisible, isRestoreMode }) })

  return {
    text,
    cursorPos,
    hintMessage,
    suggestions,
    selectedSuggestion,
    suggestionType,
    setText: replaceText,
    setCursorPos: replaceCursorPos,
  }
}

function isPromiseLike(value: unknown): value is Promise<unknown> {
  return typeof value === 'object' && value !== null && 'then' in value
}
