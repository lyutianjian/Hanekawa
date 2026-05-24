import { Box, Text } from 'ink'
import { theme } from '../theme.js'
import { Markdown } from './Markdown.js'

interface AssistantMessageProps {
  content: string
}

export function AssistantMessage({ content }: AssistantMessageProps) {
  if (!content.trim()) return null

  return (
    <Box flexDirection="row" marginY={1}>
      <Box width={2} flexShrink={0}>
        <Text color={theme.brand}>{'●'}</Text>
      </Box>
      <Box flexDirection="column" flexGrow={1}>
        <Markdown content={content} />
      </Box>
    </Box>
  )
}
