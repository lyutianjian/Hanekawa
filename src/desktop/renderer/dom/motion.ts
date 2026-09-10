import { motionFallback, reducedMotion } from '../model/reducedMotion.js'

/** Read live, so even a controller created before a preference change obeys it. */
export function motionPolicy() {
  return reducedMotion(document.documentElement.dataset.reducedMotion === 'true' || document.hidden)
}

export function motionDelay(normal: number): number {
  return motionFallback(normal, motionPolicy().settleImmediately)
}
