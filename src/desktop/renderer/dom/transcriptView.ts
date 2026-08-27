import { isThinkingCollapsed, thinkingHeaderLabel } from '../model/thinking.js'
import type { TranscriptItem, TranscriptState } from '../model/transcript.js'
import { splitFileMentions } from '../model/userMessage.js'
import { button } from './controls.js'
import { el, replace, show } from './dom.js'
import { icon } from './icons.js'
import { markdownNode } from './markdownView.js'

/**
 * Paints the transcript and the in-flight tool line.
 *
 * Rebuilds the whole list on every change. That is affordable because the DOM can
 * replace nodes — the property Ink lacks, and the reason `src/tui/transcript.ts`
 * needs 500 lines of static/live partitioning to do the same job. If a very long
 * session ever makes this show up in a profile, the fix is keying by item id, not
 * reintroducing that partition.
 *
 * The jump-to-bottom button is built here rather than in `paneSession.ts` because
 * every piece of scroll knowledge in the renderer already lives in this file, and
 * `paneSession.ts` has no unit tests. It is appended to a host *outside* the
 * scroller: `replace()` below empties the scroller on every paint, and an
 * absolutely positioned child of a scroll container would anchor to the bottom of
 * the content rather than to the viewport anyway.
 */
export interface TranscriptView {
  /** `toggledThinking` is the pane's set of blocks the user opened or closed by hand. */
  render(state: TranscriptState, toggledThinking: ReadonlySet<string>): void
}

export function createTranscriptView(
  container: HTMLElement,
  progressLine: HTMLElement,
  floatHost: HTMLElement,
  onToggleThinking: (id: string) => void,
): TranscriptView {
  const jump = button(
    'scroll-bottom',
    '',
    '回到最新',
    () => container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' }),
    { icon: 'arrow-down' },
  )
  jump.hidden = true
  floatHost.appendChild(jump)

  function syncJump(): void {
    show(jump, !isScrolledToBottom(container))
  }

  // Both halves are needed, and they share the one predicate so they cannot
  // disagree at its 24px boundary. `scroll` is the obvious trigger; the paint
  // below is the other one, because the *content* can move the verdict with no
  // scroll event at all — a `turn-end` dropping a draft or a `transcript-reset`
  // shortens the scroller under a reader who is then already at the tail.
  container.addEventListener('scroll', syncJump)

  return {
    render(state, toggledThinking) {
      const atBottom = isScrolledToBottom(container)
      // One column inside the scroller, not a `max-width` on the scroller itself:
      // the reading column is ~760px (design_guidance 四.2) while the scrollbar
      // has to stay at the panel's edge, and the user bubble's right alignment is
      // `margin-left: auto` — which only means "right of the column" if the
      // column is a real box.
      replace(
        container,
        el('div', 'transcript-column', ...state.items.map((item) => itemNode(item, toggledThinking, onToggleThinking))),
      )

      // Follow the tail only if the user was already there, so reading back
      // through a long turn is not yanked away on every token.
      if (atBottom) container.scrollTop = container.scrollHeight
      syncJump()

      show(progressLine, state.toolProgress !== undefined)
      progressLine.textContent = state.toolProgress ?? ''
    },
  }
}

function itemNode(
  item: TranscriptItem,
  toggledThinking: ReadonlySet<string>,
  onToggleThinking: (id: string) => void,
): HTMLElement {
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
  if (item.kind === 'thinking') return thinkingNode(item, classes, toggledThinking, onToggleThinking)
  if (item.kind === 'user') return userNode(item, classes)
  return el('div', classes.join(' '), item.text)
}

/**
 * The user's bubble, with every `@` mention drawn as a pill in place.
 *
 * Still character-for-character: the pill's label is the mention's own substring and
 * nothing around it is touched, which is what `splitFileMentions` guarantees. A
 * `<span>`, not a `<button>`: clicking it does nothing, and a control that does
 * nothing is a worse lie than plain text (the same call 5c made for the context
 * pills).
 */
function userNode(item: TranscriptItem, classes: string[]): HTMLElement {
  const segments = splitFileMentions(item.text)
  return el(
    'div',
    classes.join(' '),
    ...segments.map((segment) =>
      segment.kind === 'text'
        ? segment.text
        : el('span', 'file-chip', icon('file'), el('span', 'file-chip-label', segment.label)),
    ),
  )
}

/**
 * A disclosure header plus, when open, the reasoning itself.
 *
 * The body is **absent** while collapsed rather than hidden: the transcript is
 * `aria-live="polite"`, so a hidden-but-present streaming block is text a screen
 * reader announces that nobody asked for.
 */
function thinkingNode(
  item: TranscriptItem,
  classes: string[],
  toggledThinking: ReadonlySet<string>,
  onToggleThinking: (id: string) => void,
): HTMLElement {
  const collapsed = isThinkingCollapsed(item, toggledThinking)
  if (collapsed) classes.push('collapsed')
  // Driven by the item, never by `TranscriptState.isThinking`: that flag goes false
  // on `thinking_stop` while the block is still arriving.
  if (item.pending === true) classes.push('live')
  const label = thinkingHeaderLabel(item)
  // 「已处理 Xm Xs `⌵`」 (design_guidance 四.3): the glyph follows the label and
  // still flips to point up while the block is open — that rule matches on the
  // class, not on the position.
  const header = button('thinking-header', label, label, () => onToggleThinking(item.id), {
    trailingIcon: 'chevron-down',
  })
  header.setAttribute('aria-expanded', collapsed ? 'false' : 'true')
  return el(
    'div',
    classes.join(' '),
    header,
    collapsed ? undefined : el('div', 'thinking-body', item.text),
  )
}

function isScrolledToBottom(container: HTMLElement): boolean {
  // A few pixels of slack: fractional scroll heights never land exactly.
  return container.scrollHeight - container.scrollTop - container.clientHeight < 24
}
