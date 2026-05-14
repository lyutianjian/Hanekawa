import React from 'react'
import { Text } from 'ink'

type Props = {
  frame: number
  stalledIntensity?: number
}

// 旋转字形字符集（Braille dots 样式）
const GLYPHS = ['⣾', '⣽', '⣻', '⢿', '⡿', '⣟', '⣯', '⣷']

export function SpinnerGlyph({ frame, stalledIntensity = 0 }: Props) {
  const glyphIndex = frame % GLYPHS.length
  const glyph = GLYPHS[glyphIndex]

  // 停滞时颜色向红色偏移
  const color = stalledIntensity > 0.5 ? 'red' : stalledIntensity > 0 ? 'yellow' : 'cyan'

  return <Text color={color}>{glyph}</Text>
}
