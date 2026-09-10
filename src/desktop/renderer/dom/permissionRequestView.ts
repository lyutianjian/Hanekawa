import type { OverlayAction } from '../model/dialogActions.js'
import type { PermissionViewModel } from '../model/permissionDialog.js'
import { previewNode } from './diffView.js'
import { el, replace } from './dom.js'
import { icon, type IconName } from './icons.js'
import { actionBar } from './overlayView.js'
import { createPresence } from './presence.js'
import { PRESENCE_FALLBACK_MS } from '../model/presence.js'
import { motionPolicy } from './motion.js'

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
 * keeps its frame and width while its height follows the request. The textarea
 * and action bar remain mounted, with `.request-open` controlling availability.
 * Replying restores them immediately; the inert request can finish its visual
 * exit without consuming any text typed into the restored input.
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
  hide(immediate?: boolean): void
  finishMotion(): void
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
  actions: { onLayoutChange?: () => void; onReturnFocus?: () => void } = {},
): PermissionRequestView {
  container.setAttribute('role', 'group')
  const presence = createPresence(container, { kind: 'panel', direction: 'none', onClosed: () => replace(container) })
  let open = false
  let heightTimer: ReturnType<typeof setTimeout> | undefined

  const finishHeight = (): void => {
    clearTimeout(heightTimer)
    heightTimer = undefined
    composer.style.height = ''
    composer.classList.remove('request-changing', 'request-measuring')
  }
  composer.addEventListener('transitionend', (event) => {
    if (event.target === composer && event.propertyName === 'height') finishHeight()
  })
  const beginHeight = (): void => {
    actions.onLayoutChange?.()
    clearTimeout(heightTimer)
    if (!motionPolicy().animate) { finishHeight(); return }
    const height = composer.getBoundingClientRect().height
    if (!Number.isFinite(height) || height <= 0) return
    // Freeze without starting auto → px: otherwise px → auto in this same
    // paint is a zero-progress reversal and Chromium shortens it to nothing.
    composer.classList.add('request-measuring')
    composer.style.height = `${height}px`
    composer.classList.add('request-changing')
    composer.getBoundingClientRect()
    composer.classList.remove('request-measuring')
  }
  const endHeight = (): void => {
    if (!motionPolicy().animate) { finishHeight(); return }
    composer.style.height = 'auto'
    heightTimer = setTimeout(finishHeight, PRESENCE_FALLBACK_MS.layout)
    ;(heightTimer as unknown as { unref?: () => void }).unref?.()
  }

  return {
    finishMotion() { presence.finish(); finishHeight() },
    show(view) {
      const focusAction = !open || container.contains(document.activeElement)
      beginHeight()
      open = true
      // The tone lands on the card rather than on the capsule: the composer's
      // border is a focus affordance, and recolouring it would say "this field
      // is wrong" instead of "this request is dangerous".
      container.classList.remove('tone-normal', 'tone-caution', 'tone-danger')
      container.classList.add(`tone-${view.tone}`)
      const bar = actionBar(view.actions, onSelect, view.selectedIndex)
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
        bar,
      )
      container.setAttribute('aria-label', `${view.title}：${view.reason}`)
      composer.classList.add('request-open')
      presence.set(true)
      endHeight()
      if (focusAction) {
        const index = Math.max(0, view.actions.findIndex((action) => action.slot === view.selectedIndex))
        ;(bar.children[index] as HTMLButtonElement | undefined)?.focus()
      }
    },

    hide(immediate = false) {
      if (!open) {
        if (immediate) { presence.set(false, true); finishHeight() }
        return
      }
      if (!immediate) beginHeight()
      open = false
      composer.classList.remove('request-open')
      // The bridge reply has already happened. The old card is now absolute
      // and inert; the textarea is immediately available even during exit.
      presence.set(false, immediate)
      if (immediate) finishHeight()
      else { endHeight(); actions.onReturnFocus?.() }
    },
  }
}
