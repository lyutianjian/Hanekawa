import React, { createContext, useContext } from 'react'
import { Text, type TextProps } from 'ink'
import { useTheme } from './ThemeProvider.js'
import { resolveColor } from './color.js'
import type { Theme } from './theme.js'

export const TextHoverColorContext = createContext<keyof Theme | undefined>(undefined)

type Props = Omit<TextProps, 'color' | 'backgroundColor'> & {
  color?: keyof Theme | string
  backgroundColor?: keyof Theme | string
  children?: React.ReactNode
}

export function ThemedText({ color, backgroundColor, dimColor, ...rest }: Props) {
  const [theme] = useTheme()
  const hoverColor = useContext(TextHoverColorContext)

  let resolvedColor: string | undefined
  if (!color && hoverColor) {
    resolvedColor = resolveColor(hoverColor, theme)
  } else if (dimColor) {
    resolvedColor = theme.inactive
  } else {
    resolvedColor = resolveColor(color, theme)
  }

  return (
    <Text
      {...rest}
      color={resolvedColor as any}
      backgroundColor={resolveColor(backgroundColor, theme) as any}
      dimColor={dimColor}
    />
  )
}

export default ThemedText
