import { Text } from 'ink'
import type { TextProps } from 'ink'
import { useTheme } from './ThemeProvider.js'
import type { ThemeColors } from './ThemeProvider.js'

type ThemeColorKey = keyof ThemeColors

interface ThemedTextProps extends Omit<TextProps, 'color' | 'backgroundColor'> {
  color?: ThemeColorKey | string
  backgroundColor?: ThemeColorKey | string
}

function resolveColor(color: ThemeColorKey | string | undefined, themeColors: ThemeColors): string | undefined {
  if (!color) return undefined
  if (color in themeColors) {
    return themeColors[color as ThemeColorKey]
  }
  return color
}

export function ThemedText({ color, backgroundColor, ...props }: ThemedTextProps) {
  const { colors } = useTheme()

  return (
    <Text
      {...props}
      color={resolveColor(color, colors)}
      backgroundColor={resolveColor(backgroundColor, colors)}
    />
  )
}
