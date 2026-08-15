import { Box, Text } from 'ink'
import { theme } from '../theme.js'
import { computeWordDiff, truncateContent } from '../diff.js'

interface StructuredDiffProps {
  oldText: string
  newText: string
  maxLines?: number
  /**
   * Lines already dropped before this component saw the text, e.g. by
   * `capFileToolPreview` bounding a preview for transport. Added to the local
   * count so "... (N more lines)" stays truthful, and forces the summary line
   * even when what survived fits inside `maxLines`.
   */
  extraRemaining?: number
}

export function StructuredDiff({
  oldText,
  newText,
  maxLines = 30,
  extraRemaining = 0,
}: StructuredDiffProps) {
  const oldDisplay = truncateContent(oldText, maxLines)
  const newDisplay = truncateContent(newText, maxLines)
  const parts = computeWordDiff(oldDisplay.text, newDisplay.text)
  const truncated = oldDisplay.truncated || newDisplay.truncated || extraRemaining > 0
  const remaining = Math.max(oldDisplay.remaining, newDisplay.remaining) + extraRemaining

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
