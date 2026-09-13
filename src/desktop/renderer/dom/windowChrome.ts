import type { DesktopPlatform } from '../../types.js'
import {
  TITLEBAR_LEFT_INSET_VARIABLE,
  TITLEBAR_RIGHT_INSET_VARIABLE,
  titlebarInsets,
  type TitlebarArea,
} from '../model/windowChrome.js'

/** Structural because this Chromium API is not in every version of lib.dom. */
export interface WindowControlsOverlay {
  readonly visible: boolean
  getTitlebarAreaRect(): TitlebarArea
  addEventListener(event: 'geometrychange', listener: () => void): void
  removeEventListener(event: 'geometrychange', listener: () => void): void
}

interface ChromeWindow {
  readonly innerWidth: number
  addEventListener(event: 'resize', listener: () => void): void
  removeEventListener(event: 'resize', listener: () => void): void
}

/** Install before constructing controls; no session repaint needs to measure chrome. */
export function bindWindowChrome(
  root: HTMLElement,
  platform: DesktopPlatform,
  host: ChromeWindow,
  overlay: WindowControlsOverlay | undefined,
): () => void {
  root.dataset.platform = platform
  let geometryKnown = false

  const sync = (): void => {
    // At boot Chromium can expose the API before it has received native bounds.
    // Once it has reported geometry, visible:false means fullscreen/hidden.
    if (overlay?.visible) geometryKnown = true
    const geometry = overlay && geometryKnown
      ? { visible: overlay.visible, area: overlay.getTitlebarAreaRect() }
      : undefined
    const insets = titlebarInsets(platform, host.innerWidth, geometry)
    root.style.setProperty(TITLEBAR_LEFT_INSET_VARIABLE, `${insets.left}px`)
    root.style.setProperty(TITLEBAR_RIGHT_INSET_VARIABLE, `${insets.right}px`)
  }

  const onGeometry = (): void => {
    geometryKnown = true
    sync()
  }
  overlay?.addEventListener('geometrychange', onGeometry)
  host.addEventListener('resize', sync)
  sync()

  return () => {
    overlay?.removeEventListener('geometrychange', onGeometry)
    host.removeEventListener('resize', sync)
  }
}
