import { Box, Text } from 'ink'

interface UserMessageProps {
  content: string
}

export function UserMessage({ content }: UserMessageProps) {
  return (
    <Box marginBottom={1}>
      <Box backgroundColor="#2d2d2d" width="100%">
        <Text color="white">{'❯ '}{content}</Text>
      </Box>
    </Box>
  )
}
