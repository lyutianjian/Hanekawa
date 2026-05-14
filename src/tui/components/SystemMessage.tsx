import { Box } from 'ink'
import { ThemedText } from '../design-system/ThemedText.js'
import { StatusIcon } from '../design-system/StatusIcon.js'

interface SystemMessageProps {
  content: string
  variant?: 'info' | 'error' | 'warning' | 'success'
}

const colorMap = {
  info: 'systemMessage' as const,
  error: 'error' as const,
  warning: 'warning' as const,
  success: 'success' as const,
}

const statusMap = {
  info: 'info' as const,
  error: 'error' as const,
  warning: 'warning' as const,
  success: 'success' as const,
}

export function SystemMessage({ content, variant = 'info' }: SystemMessageProps) {
  return (
    <Box flexDirection="row" paddingY={0} paddingX={1}>
      <StatusIcon status={statusMap[variant]} />
      <ThemedText color={colorMap[variant]}>
        {'  '}{content}
      </ThemedText>
    </Box>
  )
}
