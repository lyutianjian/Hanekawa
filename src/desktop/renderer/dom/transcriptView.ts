import type { TranscriptItem, TranscriptState } from '../model/transcript.js'
import { el, replace, show } from './dom.js'
import { markdownNode } from './markdownView.js'

/**
 * Paints the transcript and the in-flight tool line.
 *
 * Rebuilds the whole list on every change. That is affordable because the DOM can
 * replace nodes — the property Ink lacks, and the reason `src/tui/transcript.ts`
 * needs 500 lines of static/live partitioning to do the same job. If a very long
 * session ever makes this show up in a profile, the fix is keying by item id, not
 * reintroducing that partition.
 */
export interface TranscriptView {
  render(state: TranscriptState): void
}

export function createTranscriptView(
  container: HTMLElement,
  progressLine: HTMLElement,
): TranscriptView {
  let lastCount = -1

  return {
    render(state) {
      const atBottom = isScrolledToBottom(container)
      replace(container, ...state.items.map(itemNode))

      // Follow the tail only if the user was already there, so reading back
      // through a long turn is not yanked away on every token.
      if (atBottom || state.items.length !== lastCount) {
        if (atBottom) container.scrollTop = container.scrollHeight
      }
      lastCount = state.items.length

      show(progressLine, state.toolProgress !== undefined)
      progressLine.textContent = state.toolProgress ?? ''
    },
  }
}

function itemNode(item: TranscriptItem): HTMLElement {
  const classes = ['item', item.kind]
  if (item.pending) classes.push('pending')
  if (item.failed) classes.push('failed')
  // Only the assistant writes markdown. A tool line, a user message and a notice
  // are commands, paths and diagnostics — they have to read back character for
  // character, so `*` stays a `*` there.
  //
  // The draft is rendered the same way while it streams: a half-written fence is
  // just a code block whose end has not arrived, and the parse cache means the
  // cost is one parse of the draft rather than one of every settled message.
  if (item.kind === 'assistant') return markdownNode(item.text, `${classes.join(' ')} md`)
  return el('div', classes.join(' '), item.text)
}

function isScrolledToBottom(container: HTMLElement): boolean {
  // A few pixels of slack: fractional scroll heights never land exactly.
  return container.scrollHeight - container.scrollTop - container.clientHeight < 24
}
