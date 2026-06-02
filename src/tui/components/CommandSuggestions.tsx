import { Box, Text, useStdout } from 'ink'
import type { CommandSuggestion } from '../suggestions/commandSuggestions.js'
import { theme } from '../theme.js'

const MAX_VISIBLE_SUGGESTIONS = 6

interface CommandSuggestionsProps {
  suggestions: CommandSuggestion[]
  selectedIndex: number
}

export function CommandSuggestions({ suggestions, selectedIndex }: CommandSuggestionsProps) {
  const { stdout } = useStdout()
  const columns = stdout.columns || 80
  if (suggestions.length === 0) return null

  const clampedSelectedIndex = Math.max(0, Math.min(selectedIndex, suggestions.length - 1))
  const maxStartIndex = Math.max(0, suggestions.length - MAX_VISIBLE_SUGGESTIONS)
  const startIndex = Math.max(
    0,
    Math.min(clampedSelectedIndex - Math.floor(MAX_VISIBLE_SUGGESTIONS / 2), maxStartIndex),
  )
  const visible = suggestions.slice(startIndex, startIndex + MAX_VISIBLE_SUGGESTIONS)

  const maxNameWidth = Math.min(
    Math.max(...suggestions.map((suggestion) => suggestion.displayText.length)),
    Math.max(1, Math.floor(columns * 0.4)),
  )
  const descriptionWidth = Math.max(0, columns - maxNameWidth - 5)

  return (
    <Box flexDirection="column" paddingX={2}>
      {visible.map((suggestion, index) => {
        const selected = startIndex + index === clampedSelectedIndex
        const name = truncate(suggestion.displayText, maxNameWidth)
        const paddedName = name + ' '.repeat(Math.max(0, maxNameWidth - name.length))
        const description = truncate((suggestion.description ?? '').replace(/\s+/g, ' '), descriptionWidth)

        return (
          <Text key={suggestion.id} color={selected ? theme.brand : undefined} dimColor={!selected} wrap="truncate">
            {paddedName}  {description}
          </Text>
        )
      })}
    </Box>
  )
}

function truncate(value: string, maxWidth: number): string {
  if (maxWidth <= 0) return ''
  if (value.length <= maxWidth) return value
  if (maxWidth === 1) return '.'
  return value.slice(0, maxWidth - 1) + '.'
}
