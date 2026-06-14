import { Box, Text } from 'ink'
import type { ThinkingBlock } from '../../harness/types.js'
import { theme } from '../theme.js'
import { Markdown } from './Markdown.js'

interface AssistantThinkingMessageProps {
  blocks: ThinkingBlock[]
  expanded?: boolean
  thinkingDurationMs?: number
  thinkingPreview?: string
  isTranscriptMode?: boolean
}

export function AssistantThinkingMessage({ blocks, expanded = false, thinkingDurationMs, thinkingPreview, isTranscriptMode = false }: AssistantThinkingMessageProps) {
  const hasBlocks = blocks.length > 0
  const redacted = hasBlocks && blocks.every((block) => block.type === 'redacted_thinking')
  const thinking = hasBlocks
    ? blocks
      .filter((block) => block.type === 'thinking')
      .map((block) => block.thinking ?? '')
      .filter((text) => text.trim().length > 0)
      .join('\n\n')
    : ''

  if (!hasBlocks && !thinkingPreview) return null

  if (redacted || (hasBlocks && !thinking.trim() && !thinkingPreview)) {
    return (
      <Text color={theme.subtleText} italic>
        Thinking (redacted)
      </Text>
    )
  }

  if (!expanded) {
    const label = thinkingDurationMs
      ? `Thought for ${Math.max(1, Math.round(thinkingDurationMs / 1000))}s`
      : 'Thinking'
    return (
      <Box flexDirection="column">
        <Text color={theme.subtleText} italic>
          {label} {!isTranscriptMode && <Text color={theme.subtleText}>(ctrl+o to expand)</Text>}
        </Text>
        {thinkingPreview && (
          <Box flexDirection="row">
            <Text color={theme.subtleText}>{'⎿  '}</Text>
            <Text color={theme.subtleText} dimColor wrap="truncate-end">
              {thinkingPreview}
            </Text>
          </Box>
        )}
      </Box>
    )
  }

  if (!thinking.trim()) return null

  return (
    <Box flexDirection="column">
      <Text color={theme.subtleText} italic>
        Thinking
      </Text>
      <Box flexDirection="row">
        <Text color={theme.subtleText}>{'⎿  '}</Text>
        <Box flexGrow={1}>
          <Markdown content={thinking} color={theme.subtleText} />
        </Box>
      </Box>
      {!isTranscriptMode && (
        <Text color={theme.subtleText}>
          (ctrl+o to collapse)
        </Text>
      )}
    </Box>
  )
}
