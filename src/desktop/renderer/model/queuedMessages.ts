import type { PersistedQueuedMessage } from '../../../harness/types.js'

/**
 * The queued-message strip as data.
 *
 * The strip exists because the desktop shell no longer drops a message typed
 * mid-turn: it hands it to the host's queue (`enqueue-message`), and the user
 * needs to see that something was accepted and is waiting rather than sent.
 *
 * DOM-free on purpose, like every `model/` module: a module imported by a test is
 * compiled in the base tsconfig program, which has no DOM lib. `dom/queueView.ts`
 * turns these rows into nodes and is the only half that knows what a click is.
 *
 * The import above is type-only, so nothing from `harness/` reaches the bundle —
 * `test/rendererImports.test.ts` polices the value form.
 */

export interface QueuedRow {
  readonly id: string
  /** Single-line, bounded; see {@link summarize}. */
  readonly label: string
  /** 1-based position, so the strip reads as an order rather than a set. */
  readonly position: number
}

export interface QueuedMessagesView {
  readonly rows: readonly QueuedRow[]
  /** `undefined` when nothing is waiting, which is also how the view stays hidden. */
  readonly title: string | undefined
  readonly clearLabel: string
}

/**
 * How much of a message the strip shows.
 *
 * Long enough to recognise which message is which, short enough that three of
 * them do not push the composer off screen. The transcript shows the whole thing
 * once it is actually sent.
 */
export const QUEUED_LABEL_MAX_CHARS = 120

export function queuedMessagesView(
  messages: readonly PersistedQueuedMessage[],
): QueuedMessagesView {
  const rows = messages.map((message, index) => ({
    id: message.id,
    label: label(message),
    position: index + 1,
  }))

  return {
    rows,
    title: rows.length === 0
      ? undefined
      : `已排队 ${rows.length} 条 — 当前轮次结束后发送`,
    clearLabel: '清空',
  }
}

/**
 * What a waiting message reads as.
 *
 * A queued message can carry attachment refs, and an image-only one has no text
 * at all — summarizing it alone would draw a blank row for a message that is
 * about to be sent. The image count is appended rather than replacing the text
 * so a row still says which message it is; the same 「图片：文件名」 fallback the
 * session title uses (`deriveSessionTitle`) covers the text-less case.
 */
function label(message: PersistedQueuedMessage): string {
  const images = message.images ?? []
  if (images.length === 0) return summarize(message.content)
  const text = summarize(message.content)
  // Bounded like any other label: a dozen attached files must not out-run the row.
  if (text.length === 0) return summarize(`图片：${images.map((ref) => ref.name).join('、')}`)
  return `${text} · ${images.length} 张图片`
}

/**
 * One line, bounded.
 *
 * Newlines are collapsed rather than kept: the strip is a single row per message,
 * and a pasted multi-line prompt would otherwise silently take over the window.
 * Trailing whitespace goes first so the ellipsis is never preceded by a space.
 */
function summarize(content: string): string {
  const oneLine = content.replace(/\s+/g, ' ').trim()
  if (oneLine.length <= QUEUED_LABEL_MAX_CHARS) return oneLine
  return `${oneLine.slice(0, QUEUED_LABEL_MAX_CHARS).trimEnd()}…`
}
