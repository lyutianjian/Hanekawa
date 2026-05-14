import { Box } from 'ink'
import { ThemedText } from '../design-system/ThemedText.js'

interface UserMessageProps {
  content: string
}

export function UserMessage({ content }: UserMessageProps) {
  return (
    <Box flexDirection="row" paddingY={0} paddingX={1}>
      <ThemedText color="prompt" bold>{'> '}</ThemedText>
      <ThemedText color="userMessage">{content}</ThemedText>
    </Box>
  )
}
