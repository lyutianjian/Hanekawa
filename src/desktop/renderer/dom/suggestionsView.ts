import { completionRows, type CompletionState } from '../model/completion.js'
import { el, replace, show } from './dom.js'

/**
 * The completion dropdown, for both slash commands and `@` file mentions.
 *
 * Split out of `composerView.ts` in 4e. Both completion sources reduce to the
 * same two fields before they get here, which is the whole reason this file
 * never had to learn what a file mention is.
 */

export interface SuggestionsView {
  render(state: CompletionState): void
}

export function createSuggestionsView(container: HTMLElement): SuggestionsView {
  return {
    render(state) {
      const rows = completionRows(state)
      if (rows.length === 0) {
        show(container, false)
        replace(container)
        return
      }
      const selectedIndex = state.kind === 'none' ? -1 : state.selectedIndex
      replace(container, ...rows.map((row, index) => {
        const node = el('div', `suggestion${index === selectedIndex ? ' selected' : ''}`)
        node.setAttribute('role', 'option')
        node.setAttribute('aria-selected', String(index === selectedIndex))
        node.appendChild(el('span', 'name', row.displayText))
        node.appendChild(el('span', 'description', row.description ?? ''))
        return node
      }))
      show(container, true)
    },
  }
}
