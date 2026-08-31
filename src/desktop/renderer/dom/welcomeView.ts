import {
  welcomeRenderSignature,
  type WelcomeCard,
  type WelcomePill,
  type WelcomeView,
} from '../model/welcome.js'
import { el, replace, show } from './dom.js'
import { button } from './controls.js'
import { icon } from './icons.js'

/**
 * The empty-state screen as DOM.
 *
 * Mounted inside the pane's own subtree rather than as a singleton panel, so it
 * is hidden with the rest of a backgrounded pane and one pane's Hero can never
 * be left painted over another's conversation.
 *
 * Every decision is `model/welcome.ts`'s, including whether this is visible at
 * all. Two things belong here and nowhere else: the Hero line is assembled from
 * three view fields so the project name can be a real `<button>` in the middle of
 * a sentence, and the context pills are `<span>`s — they are read-only, and a
 * button that does nothing when clicked is a worse lie than plain text.
 */

export interface WelcomeDom {
  render(view: WelcomeView): void
}

export function createWelcomeView(
  container: HTMLElement,
  onSwitchWorkspace: () => void,
  onFocusComposer: () => void,
): WelcomeDom {
  const cardNode = (card: WelcomeCard): HTMLElement =>
    button(
      `welcome-card ${card.kind}`,
      card.title,
      card.title,
      // Guidance only: the card focuses the composer and says nothing into it.
      onFocusComposer,
      { icon: card.icon },
    )

  const pillNode = (pill: WelcomePill): HTMLElement => {
    const node = el('span', `welcome-pill ${pill.kind}`)
    node.appendChild(icon(pill.icon))
    node.appendChild(el('span', 'welcome-pill-label', pill.label))
    return node
  }

  /**
   * The last drawn signature. Load-bearing: this renders from the pane's single
   * transcript paint, which runs once per streamed token.
   */
  let drawn: string | undefined

  return {
    render(view) {
      const signature = welcomeRenderSignature(view)
      if (signature === drawn) return
      drawn = signature
      show(container, view.visible)
      if (!view.visible) {
        // Dropped rather than left in the tree: an invisible Hero still holds a
        // focusable button, which Tab would walk into from the composer.
        replace(container)
        return
      }

      const mark = el('div', 'welcome-mark')
      mark.appendChild(icon('thought-bubble'))

      const title = el(
        'h1',
        'welcome-title',
        view.titleBefore,
        button(
          'welcome-project',
          view.projectLabel,
          view.projectSwitchable ? '在侧栏中定位该工作区' : view.projectLabel,
          onSwitchWorkspace,
          { enabled: view.projectSwitchable },
        ),
        view.titleAfter,
      )

      const cards = el('div', 'welcome-cards')
      for (const card of view.cards) cards.appendChild(cardNode(card))

      const pills = el('div', 'welcome-pills')
      for (const pill of view.pills) pills.appendChild(pillNode(pill))

      replace(container, mark, title, cards, pills)
    },
  }
}
