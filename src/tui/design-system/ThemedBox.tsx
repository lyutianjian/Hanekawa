import { Box } from 'ink'
import type { BoxProps } from 'ink'
import type { ReactNode } from 'react'
import { useTheme } from './ThemeProvider.js'
import type { ThemeColors } from './ThemeProvider.js'

type ThemeColorKey = keyof ThemeColors

interface ThemedBoxProps extends Omit<BoxProps, 'borderColor' | 'backgroundColor'> {
  children?: ReactNode
  borderColor?: ThemeColorKey | string
  backgroundColor?: ThemeColorKey | string
}

function resolveColor(color: ThemeColorKey | string | undefined, themeColors: ThemeColors): string | undefined {
  if (!color) return undefined
  if (color in themeColors) {
    return themeColors[color as ThemeColorKey]
  }
  return color
}

export function ThemedBox({ borderColor, backgroundColor, ...props }: ThemedBoxProps) {
  const { colors } = useTheme()

  return (
    <Box
      {...props}
      borderColor={resolveColor(borderColor, colors)}
      backgroundColor={resolveColor(backgroundColor, colors)}
    />
  )
}
