import { Box, Text } from 'ink'
import { theme } from '../theme.js'
import { computeWordDiff, truncateContent } from '../diff.js'

interface StructuredDiffProps {
  oldText: string
  newText: string
  maxLines?: number
}

export function StructuredDiff({ oldText, newText, maxLines = 30 }: StructuredDiffProps) {
  const parts = computeWordDiff(oldText, newText)

  // Group parts into lines for display
  const fullText = parts.map((p) => p.value).join('')
  const { text: displayText, truncated, remaining } = truncateContent(fullText, maxLines)

  // If truncated, just show a simple summary
  if (truncated) {
    return (
      <Box flexDirection="column">
        <DiffParts parts={parts} />
        <Text color={theme.dimText} dimColor>
          ... ({remaining} more lines)
        </Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      <DiffParts parts={parts} />
    </Box>
  )
}

function DiffParts({ parts }: { parts: ReturnType<typeof computeWordDiff> }) {
  return (
    <Text>
      {parts.map((part, i) => {
        if (part.removed) {
          return (
            <Text key={i} color={theme.error} strikethrough>
              {part.value}
            </Text>
          )
        }
        if (part.added) {
          return (
            <Text key={i} color={theme.success}>
              {part.value}
            </Text>
          )
        }
        return <Text key={i}>{part.value}</Text>
      })}
    </Text>
  )
}
