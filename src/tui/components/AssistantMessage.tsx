import { Box, Text } from 'ink'
import { useTheme } from '../design-system/ThemeProvider.js'
import { renderMarkdown } from '../utils/markdown.js'

interface AssistantMessageProps {
  content: string
  isStreaming?: boolean
}

export function AssistantMessage({ content, isStreaming }: AssistantMessageProps) {
  const { colors } = useTheme()

  if (!content && !isStreaming) return null

  const rendered = content ? renderMarkdown(content, colors) : ''

  return (
    <Box flexDirection="column" paddingY={0} paddingX={1}>
      <Box flexDirection="row">
        <Text color={colors.dimmed}>{'⎿  '}</Text>
        <Box flexDirection="column" flexGrow={1}>
          {isStreaming && !content ? (
            <Text color={colors.dimmed}>Thinking...</Text>
          ) : (
            <Text>{rendered}</Text>
          )}
          {isStreaming && content && (
            <Text color={colors.accent}>▊</Text>
          )}
        </Box>
      </Box>
    </Box>
  )
}
