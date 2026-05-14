import { Box, Text, useInput } from 'ink'
import { ThemedBox } from '../design-system/ThemedBox.js'
import { ThemedText } from '../design-system/ThemedText.js'
import { useTheme } from '../design-system/ThemeProvider.js'

interface PermissionPromptProps {
  toolName: string
  riskLevel: string
  input?: unknown
  onApprove: () => void
  onDeny: () => void
  onApproveAll: () => void
}

function formatToolDescription(toolName: string, input?: unknown): string {
  if (!input) return toolName
  if (typeof input === 'string') {
    const truncated = input.length > 80 ? input.slice(0, 80) + '...' : input
    return `${toolName}: ${truncated}`
  }
  if (typeof input === 'object') {
    const obj = input as Record<string, unknown>
    if (typeof obj.command === 'string') {
      const cmd = obj.command.length > 60 ? obj.command.slice(0, 60) + '...' : obj.command
      return `${toolName}: ${cmd}`
    }
    if (typeof obj.path === 'string') {
      return `${toolName}: ${obj.path}`
    }
  }
  return toolName
}

export function PermissionPrompt({ toolName, riskLevel, input, onApprove, onDeny, onApproveAll }: PermissionPromptProps) {
  const { colors } = useTheme()

  useInput((inputChar, key) => {
    if (inputChar === 'y' || key.return) {
      onApprove()
    } else if (inputChar === 'n') {
      onDeny()
    } else if (inputChar === 'a') {
      onApproveAll()
    }
  })

  const riskColor = riskLevel === 'dangerous' ? colors.error : riskLevel === 'confirm' ? colors.warning : colors.success

  return (
    <ThemedBox flexDirection="column" borderStyle="round" borderColor="border" paddingX={1}>
      <Box>
        <ThemedText color="warning">Permission required: </ThemedText>
        <ThemedText color="accent" bold>{formatToolDescription(toolName, input)}</ThemedText>
      </Box>
      <Box>
        <ThemedText color="dimmed">Risk level: </ThemedText>
        <Text color={riskColor}>{riskLevel}</Text>
      </Box>
      <Box marginTop={1}>
        <Text>
          <ThemedText color="success">[y]</ThemedText>es{'  '}
          <ThemedText color="error">[n]</ThemedText>o{'  '}
          <ThemedText color="accent">[a]</ThemedText>lways allow
        </Text>
      </Box>
    </ThemedBox>
  )
}
