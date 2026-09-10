export interface PointerPoint { readonly x: number; readonly y: number }
export interface MenuBounds { readonly left: number; readonly right: number; readonly top: number; readonly bottom: number }
export const MENU_INTENT_DELAY_MS = 180

/** Briefly retain a submenu while the pointer crosses a sibling toward it. */
export function submenuIntentDelay(previous: PointerPoint | undefined, point: PointerPoint, menu: MenuBounds): number {
  if (!previous) return 0
  const edge = previous.x > menu.right ? menu.right : previous.x < menu.left ? menu.left : previous.x
  const fraction = (point.x - previous.x) / (edge - previous.x)
  if (!(fraction > 0 && fraction <= 1)) return 0
  const top = previous.y + (menu.top - 8 - previous.y) * fraction
  const bottom = previous.y + (menu.bottom + 8 - previous.y) * fraction
  return point.y >= top && point.y <= bottom ? MENU_INTENT_DELAY_MS : 0
}
