import type { CompletionState } from '../model/commandRouting.js'
import type { SessionControllerSnapshot } from '../../../runtime/sessionController.js'
import type { WireRuntimeSnapshot } from '../../../runtime/protocol/wire.js'
import { el, replace, show } from './dom.js'

/** The status bar, the completion dropdown and the composer's own controls. */

export interface StatusView {
  render(snapshot: SessionControllerSnapshot): void
  renderRuntime(runtime: WireRuntimeSnapshot): void
  renderSession(session: { id: string; title?: string; messageCount?: number }): void
}

export function createStatusView(els: {
  model: HTMLElement
  mode: HTMLElement
  usage: HTMLElement
  streaming: HTMLElement
  session: HTMLElement
}): StatusView {
  return {
    render(snapshot) {
      els.streaming.textContent = snapshot.isStreaming
        ? `streaming${snapshot.spinnerSubText ? `: ${snapshot.spinnerSubText}` : ''}`
        : 'idle'
      const total = snapshot.usage.total ?? { inputTokens: 0, outputTokens: 0 }
      els.usage.textContent = total.inputTokens === 0 && total.outputTokens === 0
        ? ''
        : `${format(total.inputTokens)} in / ${format(total.outputTokens)} out`
    },

    renderRuntime(runtime) {
      const provider = runtime.providerName ? ` (${runtime.providerName})` : ''
      els.model.textContent = `${runtime.model}${provider} · effort ${runtime.effort}`
      els.mode.textContent = `mode: ${runtime.permissionMode}`
    },

    renderSession(session) {
      const name = session.title ?? session.id
      // The window title is also the desktop shell's end-to-end proof: it is only
      // set after `hello()` returns, so reading it from outside the process shows
      // the whole chain worked.
      document.title = `Hanekawa — ${name}`
      els.session.textContent = name
    },
  }
}

function format(n: number): string {
  return n.toLocaleString('en-US')
}

export interface SuggestionsView {
  render(state: CompletionState): void
}

export function createSuggestionsView(container: HTMLElement): SuggestionsView {
  return {
    render(state) {
      if (state.suggestions.length === 0) {
        show(container, false)
        replace(container)
        return
      }
      replace(container, ...state.suggestions.map((suggestion, index) => {
        const node = el('div', `suggestion${index === state.selectedIndex ? ' selected' : ''}`)
        node.setAttribute('role', 'option')
        node.setAttribute('aria-selected', String(index === state.selectedIndex))
        node.appendChild(el('span', 'name', suggestion.displayText))
        node.appendChild(el('span', 'description', suggestion.description ?? ''))
        return node
      }))
      show(container, true)
    },
  }
}

export interface ComposerView {
  value(): string
  setValue(text: string, cursorPos?: number): void
  clear(): void
  focus(): void
  /** Gates submission on the turn state; see the note in `keymap.ts`. */
  setStreaming(streaming: boolean): void
  autosize(): void
}

export const MAX_COMPOSER_HEIGHT_PX = 200

export function createComposerView(els: {
  input: HTMLTextAreaElement
  submit: HTMLButtonElement
  stop: HTMLButtonElement
}): ComposerView {
  const autosize = () => {
    els.input.style.height = 'auto'
    els.input.style.height = `${Math.min(els.input.scrollHeight, MAX_COMPOSER_HEIGHT_PX)}px`
  }

  return {
    value: () => els.input.value,
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
      // Both the button and the Enter path have to be gated: `requestSubmit()`
      // ignores a disabled *button*, and `SessionController.submit` has no
      // in-flight guard, so a second turn would overwrite the live
      // AbortController and leave the first one impossible to interrupt.
      els.submit.disabled = streaming
      show(els.submit, !streaming)
      show(els.stop, streaming)
    },
    autosize,
  }
}
