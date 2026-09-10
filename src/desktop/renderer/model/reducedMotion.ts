/** System preference policy. Browser subscription belongs to the app shell. */
export const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'
export const REDUCED_MOTION_SETTLE_MS = 1

export function reducedMotion(matches: boolean) {
  return {
    animate: !matches,
    settleImmediately: matches,
    // M15 chose immediate explicit location in both modes: no smooth scroll
    // remains in flight to compete with a wheel, drag or navigation key.
    scrollBehavior: 'auto' as const,
  }
}

export function motionFallback(normal: number, reduced: boolean): number {
  return reduced ? REDUCED_MOTION_SETTLE_MS : normal
}
