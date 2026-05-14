import { useTheme } from './ThemeProvider.js'
import type { ThemeColors } from './ThemeProvider.js'

type ThemeColorKey = keyof ThemeColors

/**
 * Curried theme-aware color function.
 * Usage: const c = useColor(); c('accent', 'Hello') => themed colored string
 */
export function useColor() {
  const { colors } = useTheme()

  return function color(colorKey: ThemeColorKey | string, text: string): string {
    const resolvedColor = colorKey in colors
      ? colors[colorKey as ThemeColorKey]
      : colorKey

    // Use ANSI escape codes for terminal coloring
    return `\x1b[38;2;${hexToRgb(resolvedColor)}m${text}\x1b[0m`
  }
}

function hexToRgb(hex: string): string {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex)
  if (!result) return '255;255;255'
  return `${parseInt(result[1], 16)};${parseInt(result[2], 16)};${parseInt(result[3], 16)}`
}

/**
 * Get a color value from theme
 */
export function useThemeColor(colorKey: ThemeColorKey | string): string {
  const { colors } = useTheme()
  if (colorKey in colors) {
    return colors[colorKey as ThemeColorKey]
  }
  return colorKey
}
