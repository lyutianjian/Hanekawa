import { el, replace } from './dom.js'
import { icon } from './icons.js'

/**
 * The "N 个后台进程" tag above the composer. Empty at zero, which `#process-strip:empty`
 * turns into no box at all. Repaints only when the count moves, so a stream of
 * snapshot ticks does not rebuild the button under the pointer.
 */
export interface ProcessStripView {
  render(count: number): void
}

export function createProcessStripView(container: HTMLElement, onOpen: () => void): ProcessStripView {
  let drawn = 0
  return {
    render(count) {
      if (count === drawn) return
      drawn = count
      if (count === 0) {
        replace(container)
        return
      }
      const chip = el('button', 'process-chip', icon('dot'), el('span', undefined, `${count} 个后台进程`))
      chip.type = 'button'
      chip.title = '查看后台任务'
      chip.addEventListener('click', onOpen)
      replace(container, chip)
    },
  }
}
