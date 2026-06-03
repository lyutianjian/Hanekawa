import { Box, Text } from 'ink'
import type { ThinkingBlock } from '../../harness/types.js'
import { theme } from '../theme.js'
import { Markdown } from './Markdown.js'

interface AssistantThinkingMessageProps {
  blocks: ThinkingBlock[]
  expanded?: boolean
}

export function AssistantThinkingMessage({ blocks, expanded = false }: AssistantThinkingMessageProps) {
  if (blocks.length === 0) return null

  const redacted = blocks.every((block) => block.type === 'redacted_thinking')
  const thinking = blocks
    .filter((block) => block.type === 'thinking')
    .map((block) => block.thinking ?? '')
    .filter((text) => text.trim().length > 0)
    .join('\n\n')

  if (redacted || !thinking.trim()) {
    return (
      <Text color={theme.dimText} dimColor italic>
        Thinking (redacted)
      </Text>
    )
  }

  if (!expanded) {
    return (
      <Text color={theme.dimText} dimColor italic>
        Thinking <Text color={theme.dimText} dimColor>(ctrl+o to expand)</Text>
      </Text>
    )
  }

  return (
    <Box flexDirection="column">
      <Text color={theme.dimText} dimColor italic>
        Thinking
      </Text>
      <Box paddingLeft={2}>
        <Markdown content={thinking} />
      </Box>
      <Text color={theme.dimText} dimColor>
        (ctrl+o to collapse)
      </Text>
    </Box>
  )
}
