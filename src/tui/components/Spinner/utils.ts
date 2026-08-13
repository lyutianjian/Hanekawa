import stringWidth from 'string-width'
import type { RGBColor } from './types.js'

export const ERROR_RED = { r: 171, g: 43, b: 63 }
export const FALLBACK_GRAY = { r: 128, g: 128, b: 128 }

export function getDefaultCharacters(): string[] {
  if (process.env.TERM === 'xterm-ghostty') {
    return ['·', '✢', '✳', '✶', '✻', '*']
  }
  return process.platform === 'darwin'
    ? ['·', '✢', '✳', '✶', '✻', '✽']
    : ['·', '✢', '*', '✶', '✻', '✽']
}

export function interpolateColor(color1: RGBColor, color2: RGBColor, t: number): RGBColor {
  return {
    r: Math.round(color1.r + (color2.r - color1.r) * t),
    g: Math.round(color1.g + (color2.g - color1.g) * t),
    b: Math.round(color1.b + (color2.b - color1.b) * t),
  }
}

export function toRGBColor(color: RGBColor): string {
  return `rgb(${color.r},${color.g},${color.b})`
}

export function parseHexColor(value: string): RGBColor {
  const normalized = value.startsWith('#') ? value.slice(1) : value
  if (normalized.length !== 6) return FALLBACK_GRAY
  return {
    r: Number.parseInt(normalized.slice(0, 2), 16),
    g: Number.parseInt(normalized.slice(2, 4), 16),
    b: Number.parseInt(normalized.slice(4, 6), 16),
  }
}

export function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m${seconds % 60 > 0 ? ` ${seconds % 60}s` : ''}`
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  return `${h}h${m > 0 ? ` ${m}m` : ''}`
}

export function formatTokenCount(tokens: number): string {
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k tokens`
  return `${tokens} tokens`
}

export function getGraphemeSegments(value: string): Array<{ value: string; width: number }> {
  const segmenter = typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : undefined
  const parts = segmenter
    ? [...segmenter.segment(value)].map((part) => part.segment)
    : [...value]
  return parts.map((part) => ({ value: part, width: stringWidth(part) }))
}