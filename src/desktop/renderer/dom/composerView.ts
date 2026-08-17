import { completionRows, type CompletionState } from '../model/completion.js'
import type { SessionControllerSnapshot } from '../../../runtime/sessionController.js'
import type { WireRuntimeSnapshot, WireUsageCost } from '../../../runtime/protocol/wire.js'
import { el, replace, show } from './dom.js'

/** The status bar, the completion dropdown and the composer's own controls. */

export interface StatusView {
  render(snapshot: SessionControllerSnapshot, cost?: WireUsageCost): void
  renderRuntime(runtime: WireRuntimeSnapshot): void
  renderSession(session: { id: string; title?: string; messageCount?: number }): void
}

export function createStatusView(els: {
  model: HTMLElement
  mode: HTMLElement
  usage: HTMLElement
  cost: HTMLElement
  streaming: HTMLElement
  session: HTMLElement
}): StatusView {
  return {
    render(snapshot, cost) {
      els.streaming.textContent = snapshot.isStreaming
        ? `streaming${snapshot.spinnerSubText ? `: ${snapshot.spinnerSubText}` : ''}`
        : 'idle'
      const total = snapshot.usage.total ?? { inputTokens: 0, outputTokens: 0 }
      els.usage.textContent = total.inputTokens === 0 && total.outputTokens === 0
        ? ''
        : `${format(total.inputTokens)} in / ${format(total.outputTokens)} out`
      // Absent rather than zero when the model has no complete pricing: "not
      // priced" and "free" are different answers, and the host already decided
      // which one this is (`resolveUsageWithCost`).
      els.cost.textContent = cost ? `${cost.currency} ${formatCost(cost.amount)}` : ''
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

/**
 * Enough digits to see a cheap turn move the number, without a wall of zeros.
 *
 * Deliberately its own formatter rather than a shared one with `/cost`
 * (`commands/cost.ts`): that view has a whole row to fill and prints six
 * decimals, while this one sits in a status bar between four other fields.
 */
function formatCost(amount: number): string {
  if (amount === 0) return '0'
  if (amount < 0.01) return amount.toFixed(4)
  return amount.toFixed(2)
}

export interface SuggestionsView {
  render(state: CompletionState): void
}

export function createSuggestionsView(container: HTMLElement): SuggestionsView {
  return {
    render(state) {
      // Both sources reduce to the same two fields, which is the whole reason
      // this file did not have to learn what a file mention is.
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
  autosize(): void
}

export const MAX_COMPOSER_HEIGHT_PX = 200

/** What the submit button says in each of its two jobs. */
export const SUBMIT_LABEL = 'Send'
export const QUEUE_LABEL = 'Queue'

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
      els.submit.textContent = streaming ? QUEUE_LABEL : SUBMIT_LABEL
      show(els.stop, streaming)
    },
    autosize,
  }
}
