import {
  composerChipView,
  insertMentionToken,
  permissionPillView,
  submitButtonView,
} from '../model/composer.js'
import type { PermissionMode } from '../../../harness/permissions.js'
import type { WireRuntimeSnapshot } from '../../../runtime/protocol/wire.js'
import { el, replace, show } from './dom.js'
import { button } from './controls.js'
import { icon } from './icons.js'

/**
 * The composer: a capsule containing the textarea and an inline action bar.
 *
 * `design_guidance.md`'s anchored composite input — attachment control bottom
 * left, a "model · effort" chip and a round send button bottom right. The chip
 * is where stage-4 decision 4 lands: effort is adjustable next to the message
 * it will affect, and never appears in settings.
 *
 * Both halves of the chip open the *existing* pickers by running `/model` and
 * `/effort`, not by calling `SessionClient.setModel` / `setEffort`. That is the
 * rule `model/surfaces.ts` already states: the slash command is the user
 * expressing a preference, and it is what writes the choice back to config —
 * `setModel` only points the live runtime somewhere else and silently drops the
 * persistence. The effort picker additionally draws over-ceiling levels as
 * disabled-with-a-reason, which a chip cycling blindly could not.
 *
 * The permission pill beside `+` is the exception, and deliberately so: the mode
 * *is* the live gate's state, there is nothing to persist, and the settings
 * screen's `permissions.mode` is only the startup mode. So it calls
 * `set-permission-mode` directly and its menu is built here rather than opened
 * as a surface — four fixed options do not need a picker panel.
 */

export interface ComposerView {
  value(): string
  /**
   * The caret offset. `applyFileSuggestion` splices over the `@…` token that
   * ends here, so "the end of the text" is not a usable substitute — a mention
   * edited in the middle of a line would rewrite the wrong span.
   */
  cursorPos(): number
  setValue(text: string, cursorPos?: number): void
  clear(): void
  focus(): void
  /**
   * Retargets the submit button between sending and queueing.
   *
   * It used to *disable* the button, because a second `SessionController.submit`
   * would overwrite the live `AbortController` and leave the first turn
   * impossible to interrupt. The kernel now rejects that outright, so mid-turn
   * input has somewhere to go: the host's message queue. Both this button and the
   * Enter path have to agree on which it is — `requestSubmit()` ignores a
   * disabled button, so a mismatch here silently swallows a click.
   */
  setStreaming(streaming: boolean): void
  /**
   * Repaints the model · effort chip and the permission pill. Driven by the
   * active pane's snapshot — including a missing one, so a pane that has not
   * finished starting shows placeholders rather than the previous pane's model.
   */
  renderRuntime(runtime: WireRuntimeSnapshot | undefined): void
  /**
   * Recomputes the send button's three visual states. Called on every keystroke,
   * because emptiness is one of the inputs.
   */
  refreshSubmit(): void
  /**
   * Shuts any transient popup the composer owns.
   *
   * Called when a pane goes to the background: the composer is a singleton the
   * *active* pane drives, so a menu left open would hang over the next pane's
   * runtime and act on it.
   */
  closeMenus(): void
  autosize(): void
}

export const MAX_COMPOSER_HEIGHT_PX = 200

export function createComposerView(els: {
  input: HTMLTextAreaElement
  submit: HTMLButtonElement
  stop: HTMLButtonElement
  attach: HTMLButtonElement
  chipModel: HTMLButtonElement
  chipEffort: HTMLButtonElement
  /** The permission-mode pill's trigger, and the shell its menu is drawn into. */
  chipPermission: HTMLButtonElement
  permissionShell: HTMLElement
  /** The spinning ring beside the chip while a turn is in flight. */
  progress: HTMLElement
}, actions: {
  onOpenModelPicker: () => void
  onOpenEffortPicker: () => void
  /** Applies a permission mode to the *live* gate — see `permissionPillView`. */
  onSelectPermissionMode: (mode: PermissionMode) => void
  /**
   * The attachment control. There is no host command behind a file dialog, so
   * it seeds an `@` and lets the existing mention completion take over — the
   * same path typing `@` follows. The callback is what tells the pane to
   * recompute completions, since a programmatic edit fires no `input` event.
   */
  onAttach: () => void
}): ComposerView {
  const autosize = () => {
    // Kept in step with `#composer` / `#input`'s `max-height` in `styles.css`;
    // this one is load-bearing, because `scrollHeight` has to be clamped by
    // something the stylesheet cannot know.
    els.input.style.height = 'auto'
    els.input.style.height = `${Math.min(els.input.scrollHeight, MAX_COMPOSER_HEIGHT_PX)}px`
  }

  // The last snapshot this view painted, so opening the menu can redraw the pill
  // without waiting for the host to post another one.
  let runtimeSnapshot: WireRuntimeSnapshot | undefined
  let permissionMenuOpen = false
  let streamingNow = false

  // Icon-only controls; the accessible name comes from `aria-label`, refreshed
  // by `setStreaming` for the one button whose meaning changes.
  replace(els.submit, icon('send'))
  replace(els.stop, icon('stop'))
  replace(els.attach, icon('plus'))
  replace(els.progress, icon('spinner'))
  els.attach.setAttribute('aria-label', '插入文件引用')
  els.attach.title = '插入文件引用（@）'
  els.progress.setAttribute('aria-hidden', 'true')
  show(els.progress, false)

  els.attach.addEventListener('click', () => {
    const next = insertMentionToken(els.input.value, els.input.selectionStart ?? els.input.value.length)
    els.input.value = next.text
    els.input.setSelectionRange(next.cursorPos, next.cursorPos)
    autosize()
    els.input.focus()
    actions.onAttach()
  })
  els.chipModel.addEventListener('click', () => actions.onOpenModelPicker())
  els.chipEffort.addEventListener('click', () => actions.onOpenEffortPicker())
  els.chipPermission.addEventListener('click', () => {
    permissionMenuOpen = !permissionMenuOpen
    renderPermission()
    if (permissionMenuOpen) firstMenuItem()?.focus()
  })

  // Closed the way the sidebar's workspace menu is: by focus leaving the shell,
  // and by Escape. `relatedTarget` is where focus *went*, so a click on a menu
  // item — which happens before the item's own `click` — must not close it.
  els.permissionShell.addEventListener('focusout', (event) => {
    const next = (event as FocusEvent).relatedTarget
    if (next instanceof Node && els.permissionShell.contains(next)) return
    if (!permissionMenuOpen) return
    permissionMenuOpen = false
    renderPermission()
  })
  els.permissionShell.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !permissionMenuOpen) return
    // Consumed here, so Escape over an open menu does not also reach the global
    // key map and close a surface or a dialog behind it.
    event.preventDefault()
    event.stopPropagation()
    permissionMenuOpen = false
    renderPermission()
    els.chipPermission.focus()
  })

  // Held rather than looked up: `querySelector` is not on the DOM surface
  // `test/helpers/domStub.ts` fakes, and a view that reaches for it would be
  // untestable for the sake of a search it already knows the answer to.
  let permissionMenu: HTMLElement | undefined
  let permissionItems: HTMLButtonElement[] = []

  function firstMenuItem(): HTMLButtonElement | undefined {
    return permissionItems[0]
  }

  function renderPermission(): void {
    const view = permissionPillView({ runtime: runtimeSnapshot, open: permissionMenuOpen })
    // The pill's own label lives in a span, so the chevron survives a repaint.
    replace(els.chipPermission, el('span', 'btn-label', view.label), icon('chevron-down'))
    els.chipPermission.title = view.title
    els.chipPermission.setAttribute('aria-label', view.title)
    els.chipPermission.setAttribute('aria-haspopup', 'listbox')
    els.chipPermission.setAttribute('aria-expanded', view.open ? 'true' : 'false')
    els.chipPermission.disabled = !view.enabled
    els.chipPermission.classList.toggle('open', view.open)

    // Rebuilt rather than hidden: the menu is a list of buttons, and a hidden
    // button is still a Tab stop in some engines.
    permissionMenu?.remove()
    permissionMenu = undefined
    permissionItems = []
    if (!view.open) {
      // The model can refuse to open (no snapshot yet); the flag has to follow,
      // or the next click would read as "close" and do nothing visible.
      permissionMenuOpen = false
      return
    }

    const menu = el('div', 'composer-menu')
    menu.setAttribute('role', 'listbox')
    menu.setAttribute('aria-label', '权限模式')
    for (const option of view.options) {
      const item = button(
        option.current ? 'composer-menu-item active' : 'composer-menu-item',
        option.label,
        option.label,
        () => {
          permissionMenuOpen = false
          renderPermission()
          actions.onSelectPermissionMode(option.mode)
          els.input.focus()
        },
      )
      item.setAttribute('role', 'option')
      item.setAttribute('aria-selected', option.current ? 'true' : 'false')
      permissionItems.push(item)
      menu.appendChild(item)
    }
    els.permissionShell.appendChild(menu)
    permissionMenu = menu
  }

  function applySubmitState(): void {
    const view = submitButtonView({
      streaming: streamingNow,
      empty: els.input.value.trim().length === 0,
    })
    // Enabled in every state: `requestSubmit()` ignores a disabled button, so a
    // grey-but-meaningful button would swallow the click with no error anywhere.
    els.submit.disabled = false
    els.submit.classList.remove('idle', 'ready', 'streaming')
    els.submit.classList.add(view.state)
    els.submit.setAttribute('aria-label', view.label)
    els.submit.title = view.label
    show(els.progress, view.progress)
  }

  els.input.addEventListener('input', () => applySubmitState())
  renderPermission()
  applySubmitState()

  return {
    value: () => els.input.value,
    // `selectionStart` is null only for input types that have no selection;
    // a textarea always reports one, and the end of the text is the safe read.
    cursorPos: () => els.input.selectionStart ?? els.input.value.length,
    setValue(text, cursorPos) {
      els.input.value = text
      if (cursorPos !== undefined) els.input.setSelectionRange(cursorPos, cursorPos)
      autosize()
      // A programmatic edit fires no `input` event, so the button state has to be
      // recomputed by hand — otherwise a restored draft leaves it reading "idle".
      applySubmitState()
    },
    clear() {
      els.input.value = ''
      autosize()
      applySubmitState()
    },
    focus() {
      els.input.focus()
    },
    setStreaming(streaming) {
      // Stop appears alongside the send button rather than instead of it:
      // interrupting the turn and queueing the next message are both things a
      // user may want mid-turn, and the round button keeps meaning "send or
      // queue" so it agrees with `model/keymap.ts`. See `submitButtonView`.
      streamingNow = streaming
      applySubmitState()
      show(els.stop, streaming)
    },
    renderRuntime(runtime) {
      runtimeSnapshot = runtime
      const chip = composerChipView(runtime)
      els.chipModel.textContent = chip.model
      els.chipModel.title = chip.modelTitle
      els.chipModel.setAttribute('aria-label', chip.modelTitle)
      els.chipModel.disabled = !chip.enabled
      els.chipEffort.textContent = chip.effort
      els.chipEffort.title = chip.effortTitle
      els.chipEffort.setAttribute('aria-label', chip.effortTitle)
      els.chipEffort.disabled = !chip.enabled
      renderPermission()
    },
    refreshSubmit: applySubmitState,
    closeMenus() {
      if (!permissionMenuOpen) return
      permissionMenuOpen = false
      renderPermission()
    },
    autosize,
  }
}
