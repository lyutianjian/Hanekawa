/**
 * Spinner 工具函数 — 复刻自 ClaudeCode/src/components/Spinner/utils.ts
 */

export type RGB = { r: number; g: number; b: number }

export function interpolateColor(c1: RGB, c2: RGB, t: number): RGB {
  return {
    r: Math.round(c1.r + (c2.r - c1.r) * t),
    g: Math.round(c1.g + (c2.g - c1.g) * t),
    b: Math.round(c1.b + (c2.b - c1.b) * t),
  }
}

export function toRGBColor(rgb: RGB): string {
  return `rgb(${rgb.r},${rgb.g},${rgb.b})`
}

export function parseRGB(colorString: string): RGB {
  // 解析 #hex 格式
  if (colorString.startsWith('#')) {
    const hex = colorString.slice(1)
    return {
      r: parseInt(hex.slice(0, 2), 16),
      g: parseInt(hex.slice(2, 4), 16),
      b: parseInt(hex.slice(4, 6), 16),
    }
  }
  // 解析 rgb(r,g,b) 格式
  const match = colorString.match(/rgb\((\d+),(\d+),(\d+)\)/)
  if (match) {
    return { r: parseInt(match[1]), g: parseInt(match[2]), b: parseInt(match[3]) }
  }
  // 默认白色
  return { r: 255, g: 255, b: 255 }
}
