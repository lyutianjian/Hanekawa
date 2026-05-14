import type { Theme } from './theme.js'

export function resolveColor(color: string | undefined, theme: Theme): string | undefined {
  if (!color) return undefined
  if (color.startsWith('rgb(') || color.startsWith('#') || color.startsWith('ansi256(') || color.startsWith('ansi:')) {
    return color
  }
  return theme[color as keyof Theme] ?? color
}
