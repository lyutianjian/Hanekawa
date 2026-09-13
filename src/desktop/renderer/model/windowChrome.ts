import type { DesktopPlatform } from '../../types.js'

export const TITLEBAR_LEFT_INSET_VARIABLE = '--titlebar-inset-left'
export const TITLEBAR_RIGHT_INSET_VARIABLE = '--titlebar-inset-right'

/** CSS pixels, as reported by Window Controls Overlay (already adjusted for zoom). */
export interface TitlebarArea {
  readonly x: number
  readonly width: number
  readonly height: number
}

export interface WindowControlsGeometry {
  readonly visible: boolean
  readonly area: TitlebarArea
}

export interface TitlebarInsets {
  readonly left: number
  readonly right: number
}

/** Undefined is not yet measured; visible:false is a confirmed hidden overlay. */
export function titlebarInsets(
  platform: DesktopPlatform,
  viewportWidth: number,
  geometry: WindowControlsGeometry | undefined,
): TitlebarInsets {
  const fallback = platform === 'darwin' ? { left: 80, right: 0 } : { left: 0, right: 138 }
  if (!geometry) return fallback
  if (!geometry.visible) return { left: 0, right: 0 }

  const { x, width, height } = geometry.area
  // Zero-sized startup rectangles and stale rectangles during resize are not
  // evidence that native buttons disappeared. Keep the platform's safe inset.
  if (![viewportWidth, x, width, height].every(Number.isFinite)
    || viewportWidth <= 0 || x < 0 || width <= 0 || height <= 0
    || x >= viewportWidth || x + width > viewportWidth + 1) return fallback

  return { left: x, right: Math.max(0, viewportWidth - x - width) }
}
