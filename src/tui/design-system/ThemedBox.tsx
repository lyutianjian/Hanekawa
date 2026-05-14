import React from 'react'
import { Box, type BoxProps } from 'ink'
import { useTheme } from './ThemeProvider.js'
import { resolveColor } from './color.js'
import type { Theme } from './theme.js'

type ThemedColorProps = {
  borderColor?: keyof Theme | string
  backgroundColor?: keyof Theme | string
}

type Props = Omit<BoxProps, 'borderColor' | 'backgroundColor'> & ThemedColorProps & {
  children?: React.ReactNode
}

export function ThemedBox({ borderColor, backgroundColor, ...rest }: Props) {
  const [theme] = useTheme()
  return (
    <Box
      {...rest}
      borderColor={resolveColor(borderColor, theme) as any}
      backgroundColor={resolveColor(backgroundColor, theme) as any}
    />
  )
}

export default ThemedBox
