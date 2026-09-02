import {
  welcomeRenderSignature,
  type WelcomeCard,
  type WelcomePill,
  type WelcomeView,
} from '../model/welcome.js'
import type { WorkspacePickerIntent } from '../model/workspacePicker.js'
import { createWorkspacePickerView, type WorkspacePickerDom } from './workspacePickerView.js'
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
 * all. Three things belong here and nowhere else: the Hero line is assembled
 * from three view fields so the project name can be a real `<button>` in the
 * middle of a sentence; the context pills are `<span>`s — they are read-only,
 * and a button that does nothing when clicked is a worse lie than plain text;
 * and the workspace picker hangs off the Hero's own row.
 *
 * The scaffolding — the title row, the picker's host, the card and pill shells —
 * is built **once** and only its contents are replaced. That is what lets the
 * picker's search box keep the caret: rebuilding the Hero around it would detach
 * the input, and a detached input is a blurred one, so every keystroke would
 * drop focus.
 */

export interface WelcomeDom {
  render(view: WelcomeView): void
  /** Puts the caret in the picker's search box, for the click that opened it. */
  focusPicker(): void
}

export interface WelcomeHandlers {
  /** The Hero's project name was clicked — open (or close) the switcher. */
  onSwitchWorkspace: () => void
  onFocusComposer: () => void
  onPickerIntent: (intent: WorkspacePickerIntent) => void
  /** Fed the raw chord; answers whether the picker consumed it. */
  onPickerKey: (chord: { key: string; ctrlKey: boolean; metaKey: boolean }) => boolean
}

export function createWelcomeView(
  container: HTMLElement,
  handlers: WelcomeHandlers,
): WelcomeDom {
  const cardNode = (card: WelcomeCard): HTMLElement =>
    button(
      `welcome-card ${card.kind}`,
      card.title,
      card.title,
      // Guidance only: the card focuses the composer and says nothing into it.
      handlers.onFocusComposer,
      { icon: card.icon },
    )

  const pillNode = (pill: WelcomePill): HTMLElement => {
    const node = el('span', `welcome-pill ${pill.kind}`)
    node.appendChild(icon(pill.icon))
    node.appendChild(el('span', 'welcome-pill-label', pill.label))
    return node
  }

  // --- the scaffolding, built once ------------------------------------------

  const mark = el('div', 'welcome-mark')
  mark.appendChild(icon('thought-bubble'))
  // The Hero's row is the picker's anchor: the popover is absolutely positioned
  // against it by the stylesheet, so nothing here measures or writes geometry.
  const titleRow = el('div', 'welcome-title-row')
  const pickerHost = el('div', 'welcome-picker-host')
  const titleSlot = el('div', 'welcome-title-slot')
  titleRow.appendChild(pickerHost)
  titleRow.appendChild(titleSlot)
  const cards = el('div', 'welcome-cards')
  const pills = el('div', 'welcome-pills')

  const picker: WorkspacePickerDom = createWorkspacePickerView(
    pickerHost,
    handlers.onPickerIntent,
    handlers.onPickerKey,
  )

  /**
   * The last drawn signature. Load-bearing: this renders from the pane's single
   * transcript paint, which runs once per streamed token.
   */
  let drawn: string | undefined
  /** Whether the scaffolding is in the container. See the `visible` branch. */
  let mounted = false
  /** Whether the cards are drawn. They are constant; the invisible pass drops them. */
  let cardsBuilt = false

  return {
    focusPicker() {
      picker.focusSearch()
    },
    render(view) {
      const signature = welcomeRenderSignature(view)
      if (signature === drawn) return
      drawn = signature
      show(container, view.visible)
      if (!view.visible) {
        // The contents go, the scaffolding stays: an invisible Hero must not
        // keep a button Tab can walk into from the composer, but the picker's
        // search input has to survive as a node — it is the one thing here that
        // holds a caret. `model/welcome.ts` forces the picker shut whenever the
        // screen is invisible, and a shut picker draws nothing focusable.
        replace(titleSlot)
        replace(cards)
        cardsBuilt = false
        replace(pills)
        picker.render(view.picker)
        return
      }
      if (!mounted) {
        replace(container, mark, titleRow, cards, pills)
        mounted = true
      }

      const title = view.global
        ? // The global workspace has no project to name — the whole Hero is the
          // ask, and no button belongs in the middle of it.
          el('h1', 'welcome-title', view.titleBefore)
        : el(
            'h1',
            'welcome-title',
            view.titleBefore,
            button(
              'welcome-project',
              view.projectLabel,
              view.projectSwitchable ? '切换工作区' : view.projectLabel,
              handlers.onSwitchWorkspace,
              { enabled: view.projectSwitchable },
            ),
            view.titleAfter,
          )
      replace(titleSlot, title)

      // The cards are constant, so they are built on the first visible paint and
      // rebuilt only after an invisible pass has emptied them — the Hero above
      // them changes with the project name; they do not.
      if (!cardsBuilt) {
        for (const card of view.cards) cards.appendChild(cardNode(card))
        cardsBuilt = true
      }
      replace(pills, ...view.pills.map(pillNode))
      picker.render(view.picker)
    },
  }
}
