import { Box, Text } from 'ink'
import { theme } from '../theme.js'

interface UserMessageProps {
  content: string
}

export function UserMessage({ content }: UserMessageProps) {
  return (
    <Box flexDirection="column" marginY={1}>
      <Box>
        <Text color={theme.userPrefix} bold>
          {' You '}
        </Text>
      </Box>
      <Box paddingLeft={2}>
        <Text>{content}</Text>
      </Box>
    </Box>
  )
}
