import { composerChipView, insertMentionToken, submitLabel } from '../model/composer.js'
import type { WireRuntimeSnapshot } from '../../../runtime/protocol/wire.js'
import { replace, show } from './dom.js'
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
  /** Repaints the model · effort chip. Driven by the active pane's snapshot. */
  renderRuntime(runtime: WireRuntimeSnapshot | undefined): void
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
}, actions: {
  onOpenModelPicker: () => void
  onOpenEffortPicker: () => void
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

  // Icon-only controls; the accessible name comes from `aria-label`, refreshed
  // by `setStreaming` for the one button whose meaning changes.
  replace(els.submit, icon('send'))
  replace(els.stop, icon('stop'))
  replace(els.attach, icon('plus'))
  els.attach.setAttribute('aria-label', '插入文件引用')
  els.attach.title = '插入文件引用（@）'

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

  return {
    value: () => els.input.value,
    // `selectionStart` is null only for input types that have no selection;
    // a textarea always reports one, and the end of the text is the safe read.
    cursorPos: () => els.input.selectionStart ?? els.input.value.length,
    setValue(text, cursorPos) {
      els.input.value = text
      if (cursorPos !== undefined) els.input.setSelectionRange(cursorPos, cursorPos)
      autosize()
    },
    clear() {
      els.input.value = ''
      autosize()
    },
    focus() {
      els.input.focus()
    },
    setStreaming(streaming) {
      // Enabled in both states now, with the label carrying the difference. Stop
      // appears alongside rather than instead of it: interrupting the turn and
      // queueing the next message are both things a user may want mid-turn.
      els.submit.disabled = false
      const label = submitLabel(streaming)
      els.submit.setAttribute('aria-label', label)
      els.submit.title = label
      show(els.stop, streaming)
    },
    renderRuntime(runtime) {
      const chip = composerChipView(runtime)
      els.chipModel.textContent = chip.model
      els.chipModel.title = chip.modelTitle
      els.chipModel.setAttribute('aria-label', chip.modelTitle)
      els.chipModel.disabled = !chip.enabled
      els.chipEffort.textContent = chip.effort
      els.chipEffort.title = chip.effortTitle
      els.chipEffort.setAttribute('aria-label', chip.effortTitle)
      els.chipEffort.disabled = !chip.enabled
    },
    autosize,
  }
}
