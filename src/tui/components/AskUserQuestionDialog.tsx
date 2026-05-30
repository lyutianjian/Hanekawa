import { useEffect, useState } from 'react'
import { Box, Text, useInput } from '../ink.js'
import { theme } from '../theme.js'
import type {
  AskUserQuestionAnswers,
  AskUserQuestionItem,
  AskUserQuestionRequest,
  AskUserQuestionResult,
} from '../../harness/types.js'

const OTHER_LABEL = 'Other'

export interface AskUserQuestionDialogProps {
  request: AskUserQuestionRequest
  onResolve(result: AskUserQuestionResult): void
}

/**
 * Multi-question multiple-choice dialog. Aligned with Claude Code's
 * AskUserQuestionPermissionRequest:
 *   - 1-4 questions per call
 *   - 2-4 options per question + an automatic "Other" free-text option
 *   - single-select (Enter on focused option) or multi-select (Space toggles, Enter submits)
 *   - Esc cancels the whole batch as `rejected`
 *   - After the last question's answer, the dialog resolves with the
 *     accumulated answers map.
 */
export function AskUserQuestionDialog({ request, onResolve }: AskUserQuestionDialogProps) {
  const total = request.questions.length
  const [questionIndex, setQuestionIndex] = useState(0)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [multiSelected, setMultiSelected] = useState<Set<number>>(new Set())
  const [otherMode, setOtherMode] = useState(false)
  const [otherText, setOtherText] = useState('')
  const [answers, setAnswers] = useState<AskUserQuestionAnswers>({})

  const current: AskUserQuestionItem | undefined = request.questions[questionIndex]
  const isMulti = current?.multiSelect === true
  // Effective option list = declared options + automatic "Other".
  const optionLabels = current ? [...current.options.map((o) => o.label), OTHER_LABEL] : []
  const otherIndex = optionLabels.length - 1

  // Reset per-question state whenever the question changes.
  useEffect(() => {
    setSelectedIndex(0)
    setMultiSelected(new Set())
    setOtherMode(false)
    setOtherText('')
  }, [questionIndex])

  const submitAnswer = (answer: string) => {
    if (!current) return
    const nextAnswers = { ...answers, [current.question]: answer }
    setAnswers(nextAnswers)
    if (questionIndex + 1 >= total) {
      onResolve({ kind: 'answered', answers: nextAnswers })
    } else {
      setQuestionIndex(questionIndex + 1)
    }
  }

  useInput((input, key) => {
    if (!current) return

    if (otherMode) {
      if (key.escape) {
        setOtherMode(false)
        setOtherText('')
        return
      }
      if (key.return) {
        const trimmed = otherText.trim()
        if (trimmed.length === 0) return
        // In multi-select, merge previously toggled options with the
        // free-text "Other" answer so the user keeps prior selections.
        if (isMulti && multiSelected.size > 0) {
          const labels = [...multiSelected]
            .sort((a, b) => a - b)
            .map((i) => optionLabels[i])
            .filter((label): label is string => typeof label === 'string')
          submitAnswer([...labels, trimmed].join(', '))
          return
        }
        submitAnswer(trimmed)
        return
      }
      if (key.backspace || key.delete) {
        setOtherText((prev) => prev.slice(0, -1))
        return
      }
      if (input && !key.ctrl && !key.meta && input.length > 0) {
        setOtherText((prev) => prev + input)
      }
      return
    }

    if (key.escape) {
      onResolve({ kind: 'rejected' })
      return
    }

    if (key.upArrow) {
      setSelectedIndex((i) => Math.max(0, i - 1))
      return
    }
    if (key.downArrow) {
      setSelectedIndex((i) => Math.min(optionLabels.length - 1, i + 1))
      return
    }

    // Multi-select toggle on Space.
    if (isMulti && input === ' ') {
      if (selectedIndex === otherIndex) {
        // "Other" is not toggleable; user must press Enter on Other to
        // enter free-text mode. The Other text will be merged with the
        // currently toggled options on submit.
        return
      }
      setMultiSelected((prev) => {
        const next = new Set(prev)
        if (next.has(selectedIndex)) next.delete(selectedIndex)
        else next.add(selectedIndex)
        return next
      })
      return
    }

    if (key.return) {
      if (isMulti) {
        // Multi-select Enter: submit all toggled options. If the focused
        // row is "Other", route to free-text input first; we'll merge the
        // typed answer with the toggled options on submit.
        if (selectedIndex === otherIndex) {
          setOtherMode(true)
          return
        }
        // If nothing has been toggled yet but the user hits Enter on a
        // real option, treat that as a single-pick fallback so plain
        // multi-select questions still work without explicit Space.
        const toggled = new Set(multiSelected)
        if (toggled.size === 0) {
          toggled.add(selectedIndex)
        }
        const labels = [...toggled]
          .sort((a, b) => a - b)
          .map((i) => optionLabels[i])
          .filter((label): label is string => typeof label === 'string')
        if (labels.length === 0) return
        submitAnswer(labels.join(', '))
        return
      }
      // Single-select Enter.
      if (selectedIndex === otherIndex) {
        setOtherMode(true)
        return
      }
      const label = optionLabels[selectedIndex]
      if (typeof label !== 'string') return
      submitAnswer(label)
      return
    }
  })

  if (!current) {
    // Empty request �?resolve immediately.
    return null
  }

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.brand} padding={1} marginY={1}>
      <Box>
        <Text color={theme.brand}>[{current.header}]</Text>
        <Text color={theme.dimText}>  Question {questionIndex + 1} of {total}</Text>
      </Box>

      <Box marginTop={1}>
        <Text bold>{current.question}</Text>
      </Box>

      {!otherMode ? (
        <Box flexDirection="column" marginTop={1}>
          {current.options.map((option, index) => {
            const isFocused = index === selectedIndex
            const isToggled = isMulti && multiSelected.has(index)
            const checkbox = isMulti ? (isToggled ? '[x] ' : '[ ] ') : ''
            return (
              <Box key={`${option.label}-${index}`} flexDirection="column">
                <Text color={isFocused ? theme.brand : undefined} bold={isFocused}>
                  {isFocused ? '> ' : '  '}{checkbox}{option.label}
                </Text>
                {option.description ? (
                  <Box paddingLeft={4}>
                    <Text color={theme.dimText}>{option.description}</Text>
                  </Box>
                ) : null}
              </Box>
            )
          })}
          <Box>
            <Text color={selectedIndex === otherIndex ? theme.brand : undefined} bold={selectedIndex === otherIndex}>
              {selectedIndex === otherIndex ? '> ' : '  '}{isMulti ? '[ ] ' : ''}{OTHER_LABEL}
            </Text>
          </Box>

          <Box marginTop={1}>
            <Text color={theme.dimText}>
              {isMulti
                ? '[Up/Down] Move  [Space] Toggle  [Enter] Submit  [Esc] Cancel'
                : '[Up/Down] Move  [Enter] Select  [Esc] Cancel'}
            </Text>
          </Box>
        </Box>
      ) : (
        <Box flexDirection="column" marginTop={1}>
          <Text bold color={theme.brand}>Type your answer (Enter to submit, Esc to cancel):</Text>
          <Box marginTop={1}>
            <Text>{otherText}<Text color={theme.brand}>_</Text></Text>
          </Box>
        </Box>
      )}
    </Box>
  )
}
