import { Box, Text } from 'ink'
import type { ThinkingBlock } from '../../harness/types.js'
import { theme } from '../theme.js'
import { Markdown } from './Markdown.js'
import { AssistantThinkingMessage } from './AssistantThinkingMessage.js'

interface AssistantMessageProps {
  content: string
  thinkingBlocks?: ThinkingBlock[]
  thinkingExpanded?: boolean
}

export function AssistantMessage({ content, thinkingBlocks, thinkingExpanded = false }: AssistantMessageProps) {
  const hasContent = content.trim().length > 0
  const hasThinking = Boolean(thinkingBlocks?.length)
  if (!hasContent && !hasThinking) return null

  return (
    <Box flexDirection="row" marginY={1}>
      <Box width={2} flexShrink={0}>
        <Text color={theme.brand}>*</Text>
      </Box>
      <Box flexDirection="column" flexGrow={1}>
        {hasThinking && <AssistantThinkingMessage blocks={thinkingBlocks!} expanded={thinkingExpanded} />}
        {hasContent && <Markdown content={content} />}
      </Box>
    </Box>
  )
}
