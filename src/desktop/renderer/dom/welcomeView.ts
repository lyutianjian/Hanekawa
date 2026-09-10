import {
  welcomeRenderSignature,
  type WelcomeHint,
  type WelcomePill,
  type WelcomeView,
} from '../model/welcome.js'
import { BRANCH_PICKER_LABEL, type BranchPickerIntent } from '../model/branchPicker.js'
import { createBranchPickerView, type BranchPickerDom } from './branchPickerView.js'
import { el, reconcile, replace, show } from './dom.js'
import { button } from './controls.js'
import { onPressOutside } from './dismiss.js'
import { icon } from './icons.js'
import { finishPresenceWithin } from './presence.js'

/**
 * The empty-state screen as DOM.
 *
 * Mounted inside the pane's own subtree rather than as a singleton panel, so it
 * is hidden with the rest of a backgrounded pane and one pane's Hero can never
 * be left painted over another's conversation.
 *
 * Every decision is `model/welcome.ts`'s, including whether this is visible at
 * all. Four things belong here and nowhere else: the masthead is one block —
 * wordmark over Hero — because the stylesheet hangs both off a single rule down
 * its left edge, and two blocks would need two rules; the Hero line is assembled
 * from three view fields so the project name can be its own node in the middle
 * of a sentence; the hint row and every pill but one are `<span>`s — they are
 * read-only, and a button that does nothing when clicked is a worse lie than
 * plain text; and the branch pill, which *is* a control, carries the branch
 * switcher in an anchor of its own.
 *
 * The scaffolding — the masthead, the title row, the pill and hint shells, and
 * the branch anchor — is built **once** and only its contents are replaced. The
 * anchor in particular has to survive: the popover inside it is the node that
 * takes focus when it opens, and rebuilding it around that focus would blur it
 * and fire the `focusout` that closes the popover the click just opened.
 */

export interface WelcomeDom {
  render(view: WelcomeView): void
  /** Puts focus in the branch popover, for the click that opened it. */
  focusBranchPicker(): void
}

export interface WelcomeHandlers {
  onBranchIntent: (intent: BranchPickerIntent) => void
  /** Fed the raw chord; answers whether the branch popover consumed it. */
  onBranchKey: (chord: { key: string; ctrlKey: boolean; metaKey: boolean }) => boolean
}

export function createWelcomeView(
  container: HTMLElement,
  handlers: WelcomeHandlers,
): WelcomeDom {
  // --- the scaffolding, built once ------------------------------------------

  // One block, because the rule down its left edge is one border: the wordmark
  // and the Hero are the same masthead, not two stacked things.
  const masthead = el('div', 'welcome-masthead')
  const eyebrow = el('div', 'welcome-wordmark')
  const titleRow = el('div', 'welcome-title-row')
  const titleSlot = el('div', 'welcome-title-slot')
  titleRow.appendChild(titleSlot)
  masthead.appendChild(eyebrow)
  masthead.appendChild(titleRow)
  const pills = el('div', 'welcome-pills')
  const hints = el('div', 'welcome-hints')
  // The branch pill's home. Persistent for the focus reason in the header, and
  // the popover is absolutely positioned against it by the stylesheet, so
  // nothing here measures or writes geometry.
  const branchAnchor = el('div', 'welcome-branch-anchor')
  // The pill itself is rebuilt whenever its label moves, so it gets a slot of
  // its own: the popover is the anchor's other child, and swapping the pill
  // around it must not touch it.
  const branchSlot = el('div', 'welcome-branch-slot')
  branchAnchor.appendChild(branchSlot)
  const branchPicker: BranchPickerDom = createBranchPickerView(
    branchAnchor,
    handlers.onBranchIntent,
    handlers.onBranchKey,
  )

  // A press anywhere else closes the popover (`dom/dismiss.ts`), which otherwise
  // has only Escape and picking a row: it hangs over the transcript, and the
  // transcript is exactly the unfocusable scenery a `focusout` cannot see.
  //
  // Scoped to the anchor — the popover *and* the pill that opens it — rather
  // than to the pill row around them: closing on a press on the trigger would
  // let its own `click` re-open the popover the user was shutting.
  onPressOutside([branchAnchor], () => handlers.onBranchIntent({ kind: 'close' }))
  // The second of the three ways every popover closes. `relatedTarget === null`
  // is this view's own repaint rather than the user leaving, and answering it
  // with a close would shut the popover on the paint that drew it.
  branchAnchor.addEventListener('focusout', (event) => {
    const next = (event as FocusEvent).relatedTarget
    if (next === null) return
    if (next instanceof Node && branchAnchor.contains(next)) return
    handlers.onBranchIntent({ kind: 'close' })
  })

  const pillNode = (pill: WelcomePill): HTMLElement => {
    if (!pill.interactive) {
      const node = el('span', `welcome-pill ${pill.kind}`)
      node.appendChild(icon(pill.icon))
      node.appendChild(el('span', 'welcome-pill-label', pill.label))
      return node
    }
    const node = button(
      `welcome-pill ${pill.kind}`,
      pill.label,
      BRANCH_PICKER_LABEL,
      () => handlers.onBranchIntent({ kind: 'open' }),
      { icon: pill.icon },
    )
    node.setAttribute('aria-haspopup', 'dialog')
    return node
  }

  /** `Shift`+`Tab` 切换权限模式 — the keys in the mono stack, the label beside. */
  const hintNode = (hint: WelcomeHint): HTMLElement => {
    const node = el('span', 'welcome-hint-item')
    for (const key of hint.keys) node.appendChild(el('kbd', 'welcome-key', key))
    node.appendChild(el('span', 'welcome-hint-label', hint.label))
    return node
  }

  /**
   * The last drawn signature. Load-bearing: this renders from the pane's single
   * transcript paint, which runs once per streamed token.
   */
  let drawn: string | undefined
  /** Whether the scaffolding is in the container. See the `visible` branch. */
  let mounted = false
  /**
   * Whether the wordmark and the hint row are drawn. Both are constant; the
   * invisible pass empties them along with everything else, so this says
   * whether they need rebuilding rather than whether they changed.
   */
  let constantsBuilt = false
  return {
    focusBranchPicker() {
      branchPicker.focusPanel()
    },
    render(view) {
      const signature = welcomeRenderSignature(view)
      if (signature === drawn) return
      drawn = signature
      show(container, view.visible)
      if (!view.visible) {
        // The contents go, the scaffolding stays: an invisible Hero must not
        // keep a button Tab can walk into from the composer, but the branch
        // anchor has to survive as a node — it is the one thing here that holds
        // focus. `model/welcome.ts` forces the popover shut whenever the screen
        // is invisible, and a shut popover draws nothing focusable.
        replace(titleSlot)
        replace(eyebrow)
        replace(hints)
        constantsBuilt = false
        branchPicker.render(view.branchPicker)
        finishPresenceWithin(branchAnchor)
        replace(pills)
        return
      }
      if (!mounted) {
        replace(container, masthead, pills, hints)
        mounted = true
      }

      const title = view.global
        ? // The global workspace has no project to name — the whole Hero is the
          // ask, and there is nothing in the middle of it.
          el('h1', 'welcome-title', view.titleBefore)
        : el(
            'h1',
            'welcome-title',
            view.titleBefore,
            // Its own node rather than part of the sentence: the project name is
            // the one span in the Hero the stylesheet marks, and it is a `<span>`
            // rather than a button because clicking it does nothing.
            el('span', 'welcome-project-name', view.projectLabel),
            view.titleAfter,
          )
      replace(titleSlot, title)

      // The wordmark and the hints are constant, so they are built on the first
      // visible paint and rebuilt only after an invisible pass has emptied them
      // — the Hero between them changes with the project name; they do not.
      if (!constantsBuilt) {
        eyebrow.appendChild(el('span', 'welcome-wordmark-label', view.wordmark))
        for (const hint of view.hints) hints.appendChild(hintNode(hint))
        constantsBuilt = true
      }
      // The branch pill goes *into* the persistent anchor, ahead of the popover
      // the anchor already holds; every other pill is a fresh node in the row.
      const rendered: HTMLElement[] = []
      for (const pill of view.pills) {
        if (pill.kind !== 'branch') {
          rendered.push(pillNode(pill))
          continue
        }
        replace(branchSlot, pillNode(pill))
        rendered.push(branchAnchor)
      }
      // `reconcile`, not `replace`: the anchor is in this list, and detaching it
      // — even for the rest of one script turn — would blur the popover inside
      // it, which is the `focusout` that closes the popover the click opened.
      reconcile(pills, rendered)
      branchPicker.render(view.branchPicker)
    },
  }
}
