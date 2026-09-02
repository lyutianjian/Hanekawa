import type { OverlayAction } from '../model/dialogActions.js'
import type { PermissionViewModel } from '../model/permissionDialog.js'
import { previewNode } from './diffView.js'
import { el, replace, show } from './dom.js'
import { icon, type IconName } from './icons.js'
import { actionBar } from './overlayView.js'

/**
 * The permission request, drawn **into the composer** rather than over the lane.
 *
 * The other three blocking requests are still modal (`dom/overlayView.ts`), and
 * deliberately: a plan decision and an `AskUserQuestion` are conversations that
 * take the whole panel. A permission request is not. It is one sentence and two
 * buttons, it arrives many times a turn, and a scrim that darkens the transcript
 * for each of them is the interruption the user is being asked about — not the
 * question itself.
 *
 * So the input transforms: the composer capsule the user's hand is already on
 * keeps its frame, its width and its place, and swaps the textarea and the
 * action bar for the request. Nothing moves; the thing you type into becomes the
 * thing you answer with. `#composer` carries `.request-open` for the duration,
 * which is what hides the two halves — a view that removed them would have to
 * put the caret back afterwards.
 *
 * What it draws comes from the same {@link PermissionViewModel} the modal used,
 * so the two cannot disagree about which options exist or which one Enter is
 * aimed at, and the button bar is literally `overlayView.ts`'s `actionBar`. The
 * keyboard path is unchanged too: `hasOverlay` still resolves to `'overlay'` in
 * `model/keymap.ts`, because the loop is parked either way and the request still
 * outranks everything else in the window.
 */
export interface PermissionRequestView {
  show(view: PermissionViewModel): void
  hide(): void
}

/** What the card reports when a button is pressed; the modal's shape. */
export type PermissionRequestSelect = (action: OverlayAction) => void

/**
 * The glyph beside the title, by what is being asked for.
 *
 * Read off the *input block*, not off a tool name: the block is already the
 * projection that knows a `Bash` request carries a command and a file tool
 * carries a path (`runtime/permissionPresentation.ts`), and matching tool names
 * here would be a second copy of that list to keep in step.
 */
export function permissionGlyphFor(kind: PermissionViewModel['inputBlock']['kind']): IconName {
  if (kind === 'bash') return 'terminal'
  if (kind === 'file') return 'file'
  return 'shield'
}

export function createPermissionRequestView(
  /** `#composer`; it carries `.request-open` while a request is on screen. */
  composer: HTMLElement,
  /** `#composer-request`, the card's own container inside the capsule. */
  container: HTMLElement,
  onSelect: PermissionRequestSelect,
): PermissionRequestView {
  container.setAttribute('role', 'group')
  show(container, false)

  return {
    show(view) {
      // The tone lands on the card rather than on the capsule: the composer's
      // border is a focus affordance, and recolouring it would say "this field
      // is wrong" instead of "this request is dangerous".
      container.className = `tone-${view.tone}`
      replace(
        container,
        el(
          'div',
          'request-head',
          icon(permissionGlyphFor(view.inputBlock.kind)),
          el('span', 'request-title', view.title),
          el('span', 'request-subtitle', view.subtitle),
        ),
        el('div', 'request-question', view.reason),
        view.denialStreakNote !== undefined && el('div', 'request-streak', view.denialStreakNote),
        ...view.warnings.map((warning) => el('div', 'request-warning', warning.message)),
        view.inputBlock.kind !== 'none' && el('div', 'request-block', view.inputBlock.content),
        view.preview !== undefined && previewNode(view.preview),
        view.alsoWaiting.length > 0
          && el('div', 'request-waiting', `还在等待：${view.alsoWaiting.join('、')}`),
        actionBar(view.actions, onSelect, view.selectedIndex),
      )
      container.setAttribute('aria-label', `${view.title}：${view.reason}`)
      show(container, true)
      composer.classList.add('request-open')
    },

    hide() {
      composer.classList.remove('request-open')
      show(container, false)
      // Emptied, not merely hidden: a hidden button is still a Tab stop in some
      // engines, and a stale one answers a request that is already settled.
      replace(container)
    },
  }
}
