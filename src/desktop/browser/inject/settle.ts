/**
 * One look at whether the page is still moving.
 *
 * The answer is a probe, not a verdict: `settle.ts` in the main process calls
 * it every poll and decides, because "stable" means *the same twice in a row*
 * and a single look cannot know that. The layout hash is what makes the
 * comparison cheap — two numbers, not two trees.
 *
 * An animation that repeats forever is left out twice over: it is not counted
 * as running, and the elements it moves are left out of the hash, or a loading
 * spinner would keep every page "moving" until the cap.
 */

import type { InjAnimation, InjElement, InjSettleDocument, InjWindow } from './dom.js'

export interface SettleProbe {
  readyState: string
  /** Running animations that will end on their own. */
  animations: number
  fontsLoading: boolean
  /** A hash of where things are; equal on two polls means nothing moved between them. */
  layout: number
}

export function hkSettleProbe(doc: InjSettleDocument, win: InjWindow, maxElements: number): SettleProbe {
  let animations = 0
  const endless = new Set<InjElement>()
  const running = doc.getAnimations ? doc.getAnimations() : []
  for (let i = 0; i < running.length; i++) {
    const animation = running[i] as InjAnimation
    if (animation.playState !== 'running' || !animation.effect) continue
    const end = animation.effect.getComputedTiming().endTime
    if (typeof end === 'number' && isFinite(end)) animations++
    else if (animation.effect.target) endless.add(animation.effect.target)
  }

  let hash = 5381
  const mix = (value: number): void => {
    hash = (Math.imul(hash, 33) ^ Math.round(value)) | 0
  }
  const all = doc.getElementsByTagName('*')
  mix(all.length)
  mix(win.scrollX)
  mix(win.scrollY)
  mix(win.innerWidth)
  mix(win.innerHeight)
  const count = Math.min(all.length, maxElements)
  for (let i = 0; i < count; i++) {
    const element = all[i] as InjElement
    if (endless.size > 0) {
      let moved = false
      for (let node: InjElement | null = element; node && !moved; node = node.parentElement) moved = endless.has(node)
      if (moved) continue
    }
    const rect = element.getBoundingClientRect()
    mix(rect.left)
    mix(rect.top)
    mix(rect.width)
    mix(rect.height)
  }

  return {
    readyState: doc.readyState,
    animations,
    fontsLoading: doc.fonts !== undefined && doc.fonts.status === 'loading',
    layout: hash,
  }
}
