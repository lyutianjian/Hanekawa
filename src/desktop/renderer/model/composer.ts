import { EFFORT_RANK, VALID_EFFORT_LEVELS, type EffortLevel } from '../../../config/effort.js'
import type { WireRuntimeSnapshot } from '../../../runtime/protocol/wire.js'

/**
 * What the composer's chip says.
 *
 * Stage-4 decision 4: effort is not a setting. It belongs beside the input,
 * where it can be changed for the next turn without leaving the conversation —
 * so the model name and the effort level live in the composer's action bar as a
 * chip, not in the status bar. (The status bar's own copy of the model was
 * deleted when this landed; two places showing the same field is two places to
 * drift.)
 *
 * Pure, and therefore testable with no DOM — `dom/composerView.ts` only turns
 * this into nodes.
 */

/**
 * Short labels for the chip. Renderer-owned copy, so Chinese directly rather
 * than through the `locale` parameter the shared presentation modules take:
 * nothing in the TUI renders this.
 */
export const EFFORT_LABELS: Record<EffortLevel, string> = {
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '极高',
  max: '最高',
}

export interface ComposerChipView {
  /** The model's display name, or a placeholder before the first snapshot. */
  readonly model: string
  readonly modelTitle: string
  /** A level's short label, or the raw value when effort is a token budget. */
  readonly effort: string
  readonly effortTitle: string
  /** Already at the model's ceiling, so the chip should not invite raising it. */
  readonly atCeiling: boolean
  /** False until a runtime snapshot has arrived; the chip is inert until then. */
  readonly enabled: boolean
}

const PLACEHOLDER = '…'

function isEffortLevel(value: string): value is EffortLevel {
  return (VALID_EFFORT_LEVELS as readonly string[]).includes(value)
}

export function composerChipView(runtime: WireRuntimeSnapshot | undefined): ComposerChipView {
  if (!runtime) {
    return {
      model: PLACEHOLDER,
      modelTitle: '尚未收到运行时快照',
      effort: PLACEHOLDER,
      effortTitle: '尚未收到运行时快照',
      atCeiling: false,
      enabled: false,
    }
  }

  const provider = runtime.providerName ? `（${runtime.providerName}）` : ''
  // `effort` is a string on the wire because it carries either a level name or a
  // raw token budget as a decimal string (`set-effort.level` is `z.string()`).
  // A budget has no position on the ladder, so it is shown verbatim.
  const level = isEffortLevel(runtime.effort) ? runtime.effort : undefined
  const atCeiling = level !== undefined
    && runtime.maxEffort !== undefined
    && EFFORT_RANK[level] >= EFFORT_RANK[runtime.maxEffort]

  const ceilingNote = atCeiling && runtime.maxEffort
    ? `（已是该模型上限 ${EFFORT_LABELS[runtime.maxEffort]}）`
    : ''

  return {
    model: runtime.model,
    modelTitle: `模型：${runtime.model}${provider} · 点击切换`,
    effort: level ? EFFORT_LABELS[level] : runtime.effort,
    effortTitle: `思考强度：${level ? EFFORT_LABELS[level] : runtime.effort}${ceilingNote} · 点击切换`,
    atCeiling,
    enabled: true,
  }
}

/**
 * What the send button means right now.
 *
 * Mid-turn the button stays *enabled* and becomes "queue" rather than going
 * grey: `SessionController.submit` rejects a concurrent turn, so the second
 * message has somewhere to go. The Enter path reaches the same verdict through
 * `model/keymap.ts`, and they must agree — `requestSubmit()` silently ignores a
 * disabled button, so a mismatch swallows the click with no error anywhere.
 */
export function submitLabel(streaming: boolean): string {
  return streaming ? '加入队列' : '发送'
}

/**
 * What the composer's `+` does.
 *
 * There is no host command behind a native file dialog, so the attachment
 * control seeds an `@` at the caret and hands over to the mention completion
 * that already exists. Inserting at the caret rather than appending is the
 * point: `@` half-way through a sentence is a normal thing to want.
 *
 * A space is inserted first when the caret is mid-word, because the mention
 * scanner only recognises an `@` that starts a token — without it the control
 * would produce a `foo@` that completes nothing. An `@` already immediately
 * before the caret is left alone rather than doubled.
 */
export function insertMentionToken(
  text: string,
  cursorPos: number,
): { text: string; cursorPos: number } {
  const at = Math.max(0, Math.min(cursorPos, text.length))
  const before = text.slice(0, at)
  if (before.endsWith('@')) return { text, cursorPos: at }

  const needsSpace = before.length > 0 && !/\s$/.test(before)
  const insertion = needsSpace ? ' @' : '@'
  return {
    text: `${before}${insertion}${text.slice(at)}`,
    cursorPos: at + insertion.length,
  }
}
