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

/** A row was picked with the mouse; the index is its slot in `completionRows`. */
export type SuggestionSelect = (index: number) => void

export function createSuggestionsView(
  container: HTMLElement,
  onSelect: SuggestionSelect,
): SuggestionsView {
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
        // `mousedown` with the default prevented, not `click`: accepting a
        // suggestion splices over the `@…` token *at the caret*, and the browser's
        // default mousedown would take focus — and the caret — off the textarea
        // before the handler ever ran.
        node.addEventListener('mousedown', (event) => {
          event.preventDefault()
          onSelect(index)
        })
        return node
      }))
      show(container, true)
    },
  }
}
