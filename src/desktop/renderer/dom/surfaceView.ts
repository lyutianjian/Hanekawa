import type { CommandViewRow } from '../model/commandRouting.js'
import type { SurfaceAction, SurfaceView } from '../model/surfaces.js'
import { el, replace, show } from './dom.js'

/**
 * The dismissible panel: a picker, or a slash command's structured view.
 *
 * Picker rows are pickable — by click, or by the arrows and Enter that
 * `keymap.ts` routes here while the composer is empty. What a row *does* is not
 * decided in this file: the model attaches a `SurfaceAction` to each row and
 * this closure hands whichever one was chosen back to `app.ts`, exactly the way
 * `tabBarView.ts` does. A row with no action (a model key that cannot be loaded)
 * is drawn to explain itself and is not clickable.
 *
 * A command view's rows stay inert — those are a table of facts, not choices.
 *
 * No `innerHTML`: labels are model- and filesystem-authored, and `script-src
 * 'self'` does nothing about an `onerror=` attribute. The `el()` helper is what
 * keeps that honest.
 */
export interface SurfacePanel {
  showSurface(view: SurfaceView, selectedIndex: number): void
  showCommandView(title: string, rows: readonly CommandViewRow[]): void
  hide(): void
  isOpen(): boolean
}

export type SurfaceActivate = (action: SurfaceAction) => void

export function createSurfacePanel(container: HTMLElement, onActivate: SurfaceActivate): SurfacePanel {
  let open = false

  const paint = (title: string, children: HTMLElement[]) => {
    replace(container, el('h2', undefined, title), ...children)
    show(container, true)
    open = true
  }

  return {
    showSurface(view, selectedIndex) {
      const rows = view.rows.map((row, index) => {
        const classes = ['row']
        if (row.current) classes.push('current')
        if (row.disabled) classes.push('disabled')
        if (row.action && index === selectedIndex) classes.push('selected')
        const node = el('div', classes.join(' '))
        node.dataset.rowId = row.id
        node.appendChild(el('span', 'label', `${row.current ? '● ' : '  '}${row.label}`))
        node.appendChild(el('span', 'value', row.disabledReason ?? row.detail))
        const action = row.action
        if (action) {
          node.setAttribute('role', 'option')
          node.setAttribute('aria-selected', String(index === selectedIndex))
          node.addEventListener('click', () => onActivate(action))
        }
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
