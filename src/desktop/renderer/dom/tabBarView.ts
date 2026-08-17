import type { TabBarView } from '../model/tabBar.js'
import { el, replace, show } from './dom.js'

/**
 * The tab bar as DOM.
 *
 * One row per tab, plus a trailing `+` button as long as the model thinks a
 * new tab is allowed. The active tab gets the `active` class; the others stay
 * neutral. A click is the only DOM-side concern this file owns — the closure
 * `onIntent` is fed whatever the model decides.
 *
 * No `innerHTML` — pasted titles are model- or filesystem-authored, and the
 * inner `textContent` path is the only thing the `script-src 'self'` CSP
 * trusts. The `el()` helper enforces that.
 */

export type TabBarAction = (intent:
  | { kind: 'switch'; paneId: string }
  | { kind: 'close'; paneId: string }
  | { kind: 'new' }
) => void

export interface TabBarDom {
  render(view: TabBarView): void
}

export function createTabBarView(container: HTMLElement, onIntent: TabBarAction): TabBarDom {
  return {
    render(view) {
      replace(
        container,
        ...view.rows.map((row) => {
          const tab = el('button', `tab${row.active ? ' active' : ''}`)
          tab.type = 'button'
          tab.dataset.paneId = row.paneId
          tab.setAttribute('role', 'tab')
          tab.setAttribute('aria-selected', String(row.active))
          tab.title = row.title
          tab.appendChild(el('span', 'tab-title', row.title))
          if (row.closable) {
            const close = el('button', 'tab-close')
            close.type = 'button'
            close.dataset.paneId = row.paneId
            close.dataset.action = 'close'
            close.setAttribute('aria-label', `Close ${row.title}`)
            close.textContent = '×'
            close.addEventListener('click', (event) => {
              event.stopPropagation()
              onIntent({ kind: 'close', paneId: row.paneId })
            })
            tab.appendChild(close)
          }
          tab.addEventListener('click', () => {
            onIntent({ kind: 'switch', paneId: row.paneId })
          })
          return tab
        }),
        ...(view.hasNewTab
          ? [
              (() => {
                const add = el('button', 'tab-add')
                add.type = 'button'
                add.setAttribute('aria-label', 'Open a new tab')
                add.textContent = '+'
                add.addEventListener('click', () => onIntent({ kind: 'new' }))
                return add
              })(),
            ]
          : []),
      )
      show(container, view.rows.length > 0 || view.hasNewTab)
    },
  }
}
