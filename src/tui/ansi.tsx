import React from 'react'
import { Text } from 'ink'

// Standard ANSI 256-color palette → hex approximation (subset used by chalk/cli-highlight)
const ANSI_256_COLORS: Record<number, string> = {
  // Standard colors (30-37)
  0: '#000000', 1: '#AA0000', 2: '#00AA00', 3: '#AA5500',
  4: '#0000AA', 5: '#AA00AA', 6: '#00AAAA', 7: '#AAAAAA',
  // Bright colors (90-97)
  8: '#555555', 9: '#FF5555', 10: '#55FF55', 11: '#FFFF55',
  12: '#5555FF', 13: '#FF55FF', 14: '#55FFFF', 15: '#FFFFFF',
  // 216-color cube (16-231)
  ...Object.fromEntries(
    Array.from({ length: 216 }, (_, i) => {
      const r = Math.floor(i / 36), g = Math.floor((i % 36) / 6), b = i % 6
      const toHex = (n: number) => ((n === 0 ? 0 : 55 + n * 40) >>> 0).toString(16).padStart(2, '0')
      return [16 + i, `#${toHex(r)}${toHex(g)}${toHex(b)}`]
    })
  ),
  // Grayscale ramp (232-255)
  ...Object.fromEntries(
    Array.from({ length: 24 }, (_, i) => {
      const v = (8 + i * 10).toString(16).padStart(2, '0')
      return [232 + i, `#${v}${v}${v}`]
    })
  ),
}

function ansi256ToHex(n: number): string {
  return ANSI_256_COLORS[n] ?? '#FFFFFF'
}

function rgbToHex(r: number, g: number, b: number): string {
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`
}

export interface AnsiSegment {
  text: string
  fg?: string
  bg?: string
  bold?: boolean
  dim?: boolean
  italic?: boolean
  underline?: boolean
  strikethrough?: boolean
}

/**
 * Parse an ANSI-escaped string into styled segments.
 * Supports SGR sequences: colors (16/256/truecolor), bold, dim, italic, underline, strikethrough.
 *
 * Uses a `touched` set to distinguish "attribute not mentioned in this SGR"
 * (carry over from previous segment) from "attribute explicitly reset"
 * (clear to default). Without this, reset codes like 39/49/0 are silently
 * ignored because `undefined` is ambiguous.
 */
export function parseAnsiToSegments(ansiString: string): AnsiSegment[] {
  const segments: AnsiSegment[] = []
  // Match SGR sequences: ESC[ ... m
  const regex = /\x1b\[([0-9;]*)m/g

  let current: AnsiSegment = { text: '' }
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = regex.exec(ansiString)) !== null) {
    // Append text before this escape sequence
    if (match.index > lastIndex) {
      current.text += ansiString.slice(lastIndex, match.index)
    }
    lastIndex = regex.lastIndex

    // Push current segment if it has text
    if (current.text) {
      segments.push(current)
    }

    // Parse SGR parameters
    const params = match[1].split(';').map(Number)
    const attrs: Partial<AnsiSegment> = {}
    // Track which attributes were explicitly touched by this SGR sequence,
    // so we can distinguish "not mentioned" from "reset to default".
    const touched: Record<string, boolean> = {}
    let i = 0
    while (i < params.length) {
      const code = params[i]
      if (code === 0) {
        // Reset all
        attrs.fg = undefined; attrs.bg = undefined
        attrs.bold = false; attrs.dim = false
        attrs.italic = false; attrs.underline = false
        attrs.strikethrough = false
        touched.fg = touched.bg = touched.bold = touched.dim =
          touched.italic = touched.underline = touched.strikethrough = true
      } else if (code === 1) { attrs.bold = true; touched.bold = true }
      else if (code === 2) { attrs.dim = true; touched.dim = true }
      else if (code === 3) { attrs.italic = true; touched.italic = true }
      else if (code === 4) { attrs.underline = true; touched.underline = true }
      else if (code === 9) { attrs.strikethrough = true; touched.strikethrough = true }
      else if (code === 22) { attrs.bold = false; attrs.dim = false; touched.bold = true; touched.dim = true }
      else if (code === 23) { attrs.italic = false; touched.italic = true }
      else if (code === 24) { attrs.underline = false; touched.underline = true }
      else if (code === 29) { attrs.strikethrough = false; touched.strikethrough = true }
      else if (code >= 30 && code <= 37) {
        attrs.fg = ANSI_256_COLORS[code - 30]; touched.fg = true
      } else if (code === 38) {
        // Extended foreground
        if (params[i + 1] === 5 && params[i + 2] !== undefined) {
          attrs.fg = ansi256ToHex(params[i + 2]); touched.fg = true; i += 2
        } else if (params[i + 1] === 2 && params[i + 4] !== undefined) {
          attrs.fg = rgbToHex(params[i + 2]!, params[i + 3]!, params[i + 4]!); touched.fg = true; i += 4
        }
      } else if (code === 39) { attrs.fg = undefined; touched.fg = true }
      else if (code >= 40 && code <= 47) {
        attrs.bg = ANSI_256_COLORS[code - 40]; touched.bg = true
      } else if (code === 48) {
        // Extended background
        if (params[i + 1] === 5 && params[i + 2] !== undefined) {
          attrs.bg = ansi256ToHex(params[i + 2]); touched.bg = true; i += 2
        } else if (params[i + 1] === 2 && params[i + 4] !== undefined) {
          attrs.bg = rgbToHex(params[i + 2]!, params[i + 3]!, params[i + 4]!); touched.bg = true; i += 4
        }
      } else if (code === 49) { attrs.bg = undefined; touched.bg = true }
      else if (code >= 90 && code <= 97) {
        attrs.fg = ANSI_256_COLORS[code - 90 + 8]; touched.fg = true
      }
      i++
    }

    // Start a new segment with carried-over state + new attributes.
    // Only carry over an attribute if it was NOT explicitly touched by this SGR.
    current = {
      text: '',
      fg: touched.fg ? attrs.fg : current.fg,
      bg: touched.bg ? attrs.bg : current.bg,
      bold: touched.bold ? attrs.bold : current.bold,
      dim: touched.dim ? attrs.dim : current.dim,
      italic: touched.italic ? attrs.italic : current.italic,
      underline: touched.underline ? attrs.underline : current.underline,
      strikethrough: touched.strikethrough ? attrs.strikethrough : current.strikethrough,
    }
  }

  // Append remaining text
  if (lastIndex < ansiString.length) {
    current.text += ansiString.slice(lastIndex)
  }
  if (current.text) {
    segments.push(current)
  }

  return segments
}

/**
 * React component that renders an ANSI-escaped string as styled Ink <Text> fragments.
 * This is the ANSI → Ink bridge, inspired by Claude Code's <Ansi> component.
 */
export function AnsiText({ children }: { children: string }): React.ReactElement {
  const segments = parseAnsiToSegments(children)
  // Wrap in a single <Text> so Ink squashes all segments into one text node.
  // Without this wrapper, each <Text> segment becomes a sibling in the parent Box,
  // causing each ANSI-colored fragment to render on its own line.
  return (
    <Text>
      {segments.map((seg, i) => (
        <Text
          key={i}
          color={seg.fg}
          backgroundColor={seg.bg}
          bold={seg.bold}
          dimColor={seg.dim}
          italic={seg.italic}
          underline={seg.underline}
          strikethrough={seg.strikethrough}
        >
          {seg.text}
        </Text>
      ))}
    </Text>
  )
}

/**
 * Check if a string contains ANSI escape codes.
 */
export function hasAnsi(str: string): boolean {
  return /\x1b\[[0-9;]*m/.test(str)
}

/**
 * Strip all ANSI SGR escape codes from a string.
 */
export function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, '')
}
