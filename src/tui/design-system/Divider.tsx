import { Box, Text } from 'ink'
import { useTheme } from './ThemeProvider.js'

interface DividerProps {
  title?: string
  width?: number
  character?: string
}

export function Divider({ title, width, character = '─' }: DividerProps) {
  const { colors } = useTheme()

  if (title) {
    const titleWithSpaces = ` ${title} `
    const remainingWidth = (width ?? 40) - titleWithSpaces.length
    const leftWidth = Math.floor(remainingWidth / 2)
    const rightWidth = remainingWidth - leftWidth

    return (
      <Box flexDirection="row">
        <Text color={colors.border}>{character.repeat(leftWidth)}</Text>
        <Text color={colors.accent} bold>{titleWithSpaces}</Text>
        <Text color={colors.border}>{character.repeat(rightWidth)}</Text>
      </Box>
    )
  }

  return (
    <Box>
      <Text color={colors.border}>{character.repeat(width ?? 40)}</Text>
    </Box>
  )
}
