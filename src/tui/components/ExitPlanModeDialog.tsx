import { useState, useEffect, useMemo } from 'react'
import { Box, Text, useInput } from '../ink.js'
import { spawn } from 'node:child_process'
import { theme } from '../theme.js'
import { Markdown } from './Markdown.js'
import { readPlan } from '../../utils/plans.js'
import type {
  CritiqueResult,
  ExitPlanDecision,
} from '../../harness/planModeManager.js'

export interface ExitPlanModeDialogProps {
  planContent: string
  planFilePath: string
  finalCritique?: CritiqueResult
  /**
   * When true, surface "bypass permissions" exit options. Mirrors Claude
   * Code's `isBypassPermissionsModeAvailable`: only show this exit when
   * the user explicitly opted into bypass before entering plan mode.
   */
  isBypassAvailable?: boolean
  isAutoModeAvailable?: boolean
  onResolve(decision: ExitPlanDecision): void
}

export interface DecisionOption {
  readonly kind: ExitPlanDecision['kind']
  readonly label: string
}

/**
 * Build the option list for the dialog. When bypass is available the user
 * sees parallel "elevated" choices for both clear-context and keep-context
 * paths, mirroring Claude Code's slot logic in `buildPlanApprovalOptions`.
 *
 * Hotkeys are assigned by index 1..N in render order so the labels stay
 * consistent without per-option metadata.
 */
export function buildExitPlanModeOptions(input: boolean | {
  isBypassAvailable?: boolean
  isAutoModeAvailable?: boolean
}): readonly DecisionOption[] {
  const isBypassAvailable = typeof input === 'boolean' ? input : input.isBypassAvailable === true
  const isAutoModeAvailable = typeof input === 'boolean' ? true : input.isAutoModeAvailable !== false
  const options: DecisionOption[] = []

  // Slot 1: clear-context approvals. ClaudeCode priority: auto > bypass > accept-edits.
  if (isAutoModeAvailable) {
    options.push({
      kind: 'approve_clear_auto_with_plan_as_prompt',
      label: 'Yes, clear context and use auto mode',
    })
  } else if (isBypassAvailable) {
    options.push({
      kind: 'approve_clear_bypass_with_plan_as_prompt',
      label: 'Yes, clear context and bypass permissions',
    })
  } else {
    options.push({
      kind: 'approve_clear_acceptEdits_with_plan_as_prompt',
      label: 'Yes, clear context and auto-accept edits',
    })
  }

  // Slot 2: keep-context with elevated mode.
  if (isAutoModeAvailable) {
    options.push({
      kind: 'approve_auto_keep',
      label: 'Yes, and use auto mode',
    })
  } else if (isBypassAvailable) {
    options.push({
      kind: 'approve_bypass_keep',
      label: 'Yes, and bypass permissions',
    })
  } else {
    options.push({
      kind: 'approve_acceptEdits_keep',
      label: 'Yes, auto-accept edits',
    })
  }

  // Slot 3: always-present default keep-context (manual approval).
  options.push({
    kind: 'approve_restore_keep',
    label: 'Yes, manually approve edits',
  })

  // Slot 4: always-present reject with feedback.
  options.push({
    kind: 'reject',
    label: 'No, keep planning',
  })

  return options
}

type ElevatedExitPlanModeDecision = 'approve_auto_keep' | 'approve_bypass_keep' | 'approve_acceptEdits_keep'

export function elevatedExitPlanModeDecision(input: boolean | {
  isBypassAvailable?: boolean
  isAutoModeAvailable?: boolean
}): ElevatedExitPlanModeDecision {
  const isBypassAvailable = typeof input === 'boolean' ? input : input.isBypassAvailable === true
  const isAutoModeAvailable = typeof input === 'boolean' ? true : input.isAutoModeAvailable !== false
  if (isAutoModeAvailable) return 'approve_auto_keep'
  return isBypassAvailable ? 'approve_bypass_keep' : 'approve_acceptEdits_keep'
}

const SAVE_MESSAGE_TIMEOUT_MS = 5000
const MAX_CRITIQUE_PREVIEW_LINES = 6
const PLAN_BORDER_STYLE = {
  topLeft: '-',
  top: '-',
  topRight: '-',
  bottomLeft: '-',
  bottom: '-',
  bottomRight: '-',
  left: '|',
  right: '|',
} as const

export function previewMarkdownLines(content: string, maxLines: number): string {
  const lines = content.split(/\r?\n/)
  if (lines.length <= maxLines) return content
  const safeMax = Math.max(1, maxLines)
  if (safeMax === 1) {
    return `${lines[0] ?? ''}\n[... ${lines.length - 1} lines omitted from preview ...]`
  }

  const omitted = lines.length - safeMax + 1
  const headCount = Math.max(1, Math.ceil((safeMax - 1) * 0.6))
  const tailCount = Math.max(0, safeMax - 1 - headCount)
  const head = lines.slice(0, headCount)
  const tail = tailCount > 0 ? lines.slice(lines.length - tailCount) : []
  return [
    ...head,
    `[... ${omitted} lines omitted from preview ...]`,
    ...tail,
  ].join('\n')
}

export function ExitPlanModeDialog({
  planContent: initialPlanContent,
  planFilePath,
  finalCritique,
  isBypassAvailable = false,
  isAutoModeAvailable = true,
  onResolve,
}: ExitPlanModeDialogProps) {
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [planContent, setPlanContent] = useState(initialPlanContent)
  const [feedback, setFeedback] = useState('')
  const [editorError, setEditorError] = useState<string | null>(null)
  const [showSaveMessage, setShowSaveMessage] = useState(false)

  const options = useMemo(
    () => buildExitPlanModeOptions({ isBypassAvailable, isAutoModeAvailable }),
    [isBypassAvailable, isAutoModeAvailable],
  )
  const critiquePreview = useMemo(
    () => finalCritique
      ? previewMarkdownLines(finalCritique.findings, MAX_CRITIQUE_PREVIEW_LINES)
      : undefined,
    [finalCritique],
  )
  const hotkeys = useMemo(
    () => options.map((_, i) => String(i + 1) as '1' | '2' | '3' | '4'),
    [options],
  )
  const isEmptyPlan = planContent.trim().length === 0

  // Keep planContent in sync if the parent re-renders with new content.
  useEffect(() => {
    setPlanContent(initialPlanContent)
  }, [initialPlanContent])

  useEffect(() => {
    if (isEmptyPlan && selectedIndex > 1) setSelectedIndex(0)
  }, [isEmptyPlan, selectedIndex])

  // Auto-hide the save confirmation. Mirrors Claude Code's 5-second timeout.
  useEffect(() => {
    if (!showSaveMessage) return
    const timer = setTimeout(() => setShowSaveMessage(false), SAVE_MESSAGE_TIMEOUT_MS)
    return () => clearTimeout(timer)
  }, [showSaveMessage])

  const openExternalEditor = async () => {
    setEditorError(null)
    const editor = process.env.VISUAL || process.env.EDITOR
      || (process.platform === 'win32' ? 'notepad' : 'nano')
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(editor, [planFilePath], { stdio: 'inherit' })
        child.on('error', reject)
        child.on('exit', (code) => {
          if (code === 0 || code === null) resolve()
          else reject(new Error(`editor exited with code ${code}`))
        })
      })
      const updated = await readPlan(planFilePath)
      if (updated !== null) {
        setPlanContent(updated)
        setShowSaveMessage(true)
      }
    } catch (error) {
      setEditorError(error instanceof Error ? error.message : String(error))
    }
  }

  const resolveOption = (option: DecisionOption) => {
    if (option.kind === 'reject') {
      onResolve({ kind: 'reject', feedback })
      return
    }
    onResolve({ kind: option.kind, planContent })
  }

  useInput((input, key) => {
    if (isEmptyPlan) {
      if (key.upArrow) {
        setSelectedIndex((i) => Math.max(0, i - 1))
        return
      }
      if (key.downArrow) {
        setSelectedIndex((i) => Math.min(1, i + 1))
        return
      }
      if (input === '1') {
        onResolve({ kind: 'approve_restore_keep', planContent })
        return
      }
      if (input === '2') {
        onResolve({ kind: 'reject', feedback: '' })
        return
      }
      if (key.return) {
        onResolve(selectedIndex === 0
          ? { kind: 'approve_restore_keep', planContent }
          : { kind: 'reject', feedback: '' })
        return
      }
      if (key.escape) {
        onResolve({ kind: 'reject', feedback: '' })
      }
      return
    }

    const selectedOption = options[selectedIndex]
    const isRejectSelected = selectedOption?.kind === 'reject'

    if (isRejectSelected) {
      if (key.backspace || key.delete) {
        setFeedback((prev) => prev.slice(0, -1))
        return
      }
    }

    // Ctrl+G opens external editor.
    if (key.ctrl && (input === 'g' || input === 'G')) {
      void openExternalEditor()
      return
    }

    // Shift+Tab = quick approval with elevated mode (auto-accept edits or
    // bypass when available). Matches Claude Code's Shift+Tab shortcut.
    if (key.shift && key.tab) {
      onResolve({
        kind: elevatedExitPlanModeDecision({ isBypassAvailable, isAutoModeAvailable }),
        planContent,
      })
      return
    }

    if (key.upArrow) {
      setSelectedIndex((i) => Math.max(0, i - 1))
      return
    }
    if (key.downArrow) {
      setSelectedIndex((i) => Math.min(options.length - 1, i + 1))
      return
    }

    // Numeric hotkeys mapped by slot order (1-based).
    if (input === '1' || input === '2' || input === '3' || input === '4') {
      const target = hotkeys.indexOf(input)
      if (target >= 0) {
        const option = options[target]
        if (option?.kind === 'reject') {
          setSelectedIndex(target)
        } else if (option) {
          resolveOption(option)
        }
      }
      return
    }

    if (key.return) {
      const option = options[selectedIndex]
      if (option) resolveOption(option)
      return
    }

    if (key.escape) {
      // Esc cancels the dialog as an empty rejection so the loop can move on.
      onResolve({ kind: 'reject', feedback: '' })
      return
    }

    if (isRejectSelected && input && !key.ctrl && !key.meta && input.length > 0) {
      setFeedback((prev) => prev + input)
    }
  })

  const elevatedHint = isAutoModeAvailable
    ? 'auto mode'
    : isBypassAvailable ? 'bypass permissions' : 'auto-accept edits'

  if (isEmptyPlan) {
    const emptyOptions = [
      { value: 'yes' as const, label: 'Yes', hotkey: '1' as const },
      { value: 'no' as const, label: 'No', hotkey: '2' as const },
    ]

    return (
      <Box flexDirection="column" borderStyle="round" borderColor={theme.warning} borderLeft={false} borderRight={false} borderBottom={false} marginTop={1}>
        <Box paddingX={1} flexDirection="column">
          <Text bold color={theme.warning}>Exit plan mode?</Text>
        </Box>

        <Box flexDirection="column" paddingX={1} marginTop={1}>
          <Text>Hanekawa wants to exit plan mode</Text>
          <Box flexDirection="column" marginTop={1}>
            {emptyOptions.map((option, index) => {
              const isSelected = index === selectedIndex
              return (
                <Text key={option.value} color={isSelected ? theme.brand : undefined} bold={isSelected}>
                  {isSelected ? '> ' : '  '}[
                  <Text color={theme.toolName} bold>{option.hotkey}</Text>
                  ] {option.label}
                </Text>
              )
            })}
          </Box>
        </Box>
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      <Box flexDirection="column" borderStyle="round" borderColor={theme.warning} borderLeft={false} borderRight={false} borderBottom={false} marginTop={1}>
        <Box paddingX={1} flexDirection="column">
          <Text bold color={theme.warning}>Ready to code?</Text>
        </Box>

        <Box flexDirection="column" marginTop={1}>
          <Box paddingX={1} flexDirection="column">
            <Text>Here is Hanekawa&apos;s plan:</Text>
          </Box>

          <Box
            borderColor={theme.border}
            borderStyle={PLAN_BORDER_STYLE}
            flexDirection="column"
            borderLeft={false}
            borderRight={false}
            paddingX={1}
            marginBottom={1}
          >
            <Markdown content={planContent} />
          </Box>

          <Box flexDirection="column" paddingX={1}>
            {critiquePreview ? (
              <Box flexDirection="column" marginBottom={1}>
                <Text bold color={theme.toolName}>Critique findings:</Text>
                <Text color={theme.dimText}>{critiquePreview}</Text>
              </Box>
            ) : null}

            {editorError ? (
              <Box marginBottom={1}>
                <Text color={theme.error}>Editor error: {editorError}</Text>
              </Box>
            ) : null}

            <Text color={theme.dimText}>
              Hanekawa has written up a plan and is ready to execute. Would you like to proceed?
            </Text>

            <Box flexDirection="column" marginTop={1}>
              {options.map((option, index) => {
                const isSelected = index === selectedIndex
                const hotkey = hotkeys[index]
                const isReject = option.kind === 'reject'
                return (
                  <Box key={option.kind} flexDirection="column">
                    <Text color={isSelected ? theme.brand : undefined} bold={isSelected}>
                      {isSelected ? '> ' : '  '}[
                      <Text color={theme.toolName} bold>{hotkey}</Text>
                      ] {option.label}
                    </Text>
                    {isReject ? (
                      <Box paddingLeft={4}>
                        <Text color={theme.dimText}>
                          Feedback: {feedback}
                          {isSelected ? <Text color={theme.brand}>_</Text> : null}
                        </Text>
                      </Box>
                    ) : null}
                  </Box>
                )
              })}
            </Box>
          </Box>
        </Box>
      </Box>

      <Box flexDirection="row" paddingX={1} marginTop={1}>
        <Text color={theme.dimText}>ctrl-g to edit plan</Text>
        <Text color={theme.dimText}> - {planFilePath}</Text>
        {showSaveMessage ? <Text color={theme.success}> - Plan saved!</Text> : null}
      </Box>
      <Box paddingX={1}>
        <Text color={theme.dimText}>
          [Up/Down] Options  [1-{options.length}] Quick  [Enter] Select  [Shift+Tab] {elevatedHint}  [Esc] Keep planning
        </Text>
      </Box>
    </Box>
  )
}
