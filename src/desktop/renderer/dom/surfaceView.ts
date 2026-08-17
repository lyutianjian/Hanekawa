import type { CommandViewRow } from '../model/commandRouting.js'
import type { SurfaceView } from '../model/surfaces.js'
import { el, replace, show } from './dom.js'

/**
 * The dismissible panel: a picker, or a slash command's structured view.
 *
 * Rows are inert text. A picker that could be *acted on* would need the renderer
 * to know which command each row maps to; today `/model sonnet` is how you pick,
 * and this panel is how you find out what to type. That is a deliberate stopping
 * point rather than an oversight — see the plan's deferred list.
 */
export interface SurfacePanel {
  showSurface(view: SurfaceView): void
  showCommandView(title: string, rows: readonly CommandViewRow[]): void
  hide(): void
  isOpen(): boolean
}

export function createSurfacePanel(container: HTMLElement): SurfacePanel {
  let open = false

  const paint = (title: string, children: HTMLElement[]) => {
    replace(container, el('h2', undefined, title), ...children)
    show(container, true)
    open = true
  }

  return {
    showSurface(view) {
      const rows = view.rows.map((row) => {
        const classes = ['row']
        if (row.current) classes.push('current')
        if (row.disabled) classes.push('disabled')
        const node = el('div', classes.join(' '))
        node.appendChild(el('span', 'label', `${row.current ? '● ' : '  '}${row.label}`))
        node.appendChild(el('span', 'value', row.disabledReason ?? row.detail))
        return node
      })
      paint(
        view.title,
        rows.length > 0 ? rows : [el('div', 'row', el('span', 'value', view.emptyMessage))],
      )
    },

    showCommandView(title, rows) {
      paint(title, rows.map((row) => {
        const classes = ['row', `tone-${row.tone}`]
        if (row.heading) classes.push('heading')
        const node = el('div', classes.join(' '))
        node.appendChild(el('span', 'label', row.label))
        node.appendChild(el('span', 'value', row.value))
        return node
      }))
    },

    hide() {
      show(container, false)
      replace(container)
      open = false
    },

    isOpen() {
      return open
    },
  }
}
