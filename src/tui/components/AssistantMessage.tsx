import { Box, Text } from 'ink'
import type { ThinkingBlock } from '../../harness/types.js'
import { theme } from '../theme.js'
import { Markdown } from './Markdown.js'
import { AssistantThinkingMessage } from './AssistantThinkingMessage.js'

interface AssistantMessageProps {
  content: string
  thinkingBlocks?: ThinkingBlock[]
  thinkingDurationMs?: number
  thinkingExpanded?: boolean
  thinkingPreview?: string
}

export function AssistantMessage({ content, thinkingBlocks, thinkingDurationMs, thinkingExpanded = false, thinkingPreview }: AssistantMessageProps) {
  const hasContent = content.trim().length > 0
  const hasThinking = Boolean(thinkingBlocks?.length) || Boolean(thinkingPreview)
  if (!hasContent && !hasThinking) return null

  return (
    <Box flexDirection="column" marginY={1}>
      {hasThinking && (
        <Box flexDirection="row">
          <Box width={2} flexShrink={0}>
            <Text color={theme.brand}>*</Text>
          </Box>
          <Box flexGrow={1}>
            <AssistantThinkingMessage blocks={thinkingBlocks ?? []} expanded={thinkingExpanded} thinkingDurationMs={thinkingDurationMs} thinkingPreview={thinkingPreview} />
          </Box>
        </Box>
      )}
      {hasContent && (
        <Box flexDirection="row" marginTop={hasThinking ? 1 : 0}>
          <Box width={2} flexShrink={0}>
            <Text color={theme.brand}>●</Text>
          </Box>
          <Box flexGrow={1}>
            <Markdown content={content} />
          </Box>
        </Box>
      )}
    </Box>
  )
}
