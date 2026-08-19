import type { TabBarView, TabRow } from '../model/tabBar.js'
import { el, replace, show } from './dom.js'

/**
 * The tab bar as DOM.
 *
 * One row per tab, grouped under a project heading once a second project is
 * open, plus a trailing `+` (new tab in this window's project) and an "Open
 * project…" button. The active tab gets the `active` class; a tab belonging to
 * another project gets `foreign` and no close button — the model decided that
 * (`TabRow.closable`), this file only draws it.
 *
 * A click is the only DOM-side concern this file owns — the closure `onIntent`
 * is fed whatever the model decides.
 *
 * No `innerHTML` — pasted titles and project names are filesystem- or
 * model-authored, and the inner `textContent` path is the only thing the
 * `script-src 'self'` CSP trusts. The `el()` helper enforces that.
 */

export type TabBarAction = (intent:
  | { kind: 'switch'; paneId: string }
  | { kind: 'close'; paneId: string }
  | { kind: 'new' }
  | { kind: 'open-project' }
) => void

export interface TabBarDom {
  render(view: TabBarView): void
}

export function createTabBarView(container: HTMLElement, onIntent: TabBarAction): TabBarDom {
  const tabNode = (row: TabRow): HTMLElement => {
    const classes = ['tab']
    if (row.active) classes.push('active')
    if (!row.own) classes.push('foreign')
    const tab = el('button', classes.join(' '))
    tab.type = 'button'
    tab.dataset.paneId = row.paneId
    tab.setAttribute('role', 'tab')
    tab.setAttribute('aria-selected', String(row.active))
    // The full project path is only interesting for a tab that is not ours.
    tab.title = row.own ? row.title : `${row.title} — ${row.projectRoot}`
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
  }

  const actionNode = (
    className: string,
    label: string,
    ariaLabel: string,
    intent: { kind: 'new' } | { kind: 'open-project' },
  ): HTMLElement => {
    const button = el('button', className)
    button.type = 'button'
    button.setAttribute('aria-label', ariaLabel)
    button.title = ariaLabel
    button.textContent = label
    button.addEventListener('click', () => onIntent(intent))
    return button
  }

  return {
    render(view) {
      const tabs: HTMLElement[] = view.showProjectLabels
        ? view.groups.map((group) => {
            const wrapper = el('div', `tab-group${group.own ? ' own' : ''}`)
            const label = el('span', 'tab-group-label', group.projectName)
            label.title = group.projectRoot
            wrapper.appendChild(label)
            for (const row of group.rows) wrapper.appendChild(tabNode(row))
            return wrapper
          })
        : view.rows.map((row) => tabNode(row))

      replace(
        container,
        ...tabs,
        ...(view.hasNewTab
          ? [actionNode('tab-add', '+', 'Open a new tab', { kind: 'new' })]
          : []),
        ...(view.hasOpenProject
          ? [
              actionNode('tab-open-project', 'Open project…', 'Open another project', {
                kind: 'open-project',
              }),
            ]
          : []),
      )
      show(container, view.rows.length > 0 || view.hasNewTab || view.hasOpenProject)
    },
  }
}
