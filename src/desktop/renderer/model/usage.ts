import type { TokenUsage } from '../../../harness/types.js'
import type { WireRuntimeSnapshot } from '../../../runtime/protocol/wire.js'

/**
 * The two token readouts under and beside the composer.
 *
 * Pure, like `model/composer.ts`: `dom/statusView.ts` and `dom/composerView.ts`
 * only turn what these return into nodes.
 *
 * The status line used to print `输入 X / 输出 Y`, which named two of the three
 * counts the loop actually tracks and hid the one that matters most on a long
 * session — `cacheReadInputTokens`, the tokens the prompt cache served. The TUI
 * had the full set (`tui/components/StatusLine.tsx`) and the desktop was the
 * degraded side; this closes that.
 *
 * `cache_creation` is deliberately *not* a fourth number:
 * `normalizeAnthropicUsage` folds cache writes into `inputTokens`, and splitting
 * them out here would mean a new field on `TokenUsage` — which is persisted in
 * every session's JSONL. "in" therefore means "billed as input, cache writes
 * included", which is also what the cost beside it is computed from.
 */

/** `--context-ratio`, written by `dom/composerView.ts` through `setProperty`. */
export const CONTEXT_RATIO_VARIABLE = '--context-ratio'

/** Above this share of the usable window the gauge starts warning. */
export const CONTEXT_WARN_RATIO = 0.8
/** Above this, autocompact is close enough that the gauge says so. */
export const CONTEXT_CRITICAL_RATIO = 0.95

/**
 * `16k` / `950k` / `1.2M`.
 *
 * Its own function rather than one shared with the TUI's identically named
 * local helper: that one is private to `StatusLine.tsx` and formats for a
 * monospaced grid, while this sits in proportional text beside a label.
 */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) {
    const thousands = n / 1000
    return `${thousands < 10 ? thousands.toFixed(1) : Math.round(thousands)}k`
  }
  const millions = n / 1_000_000
  return `${millions < 10 ? millions.toFixed(1) : Math.round(millions)}M`
}

function formatExact(n: number): string {
  return n.toLocaleString('en-US')
}

export interface StatusUsageView {
  /** Empty while nothing has been counted, so `#status` collapses to no height. */
  readonly text: string
  /** The same numbers unabbreviated, for the hover. Empty when `text` is. */
  readonly title: string
}

/**
 * Session totals: input, cache hits, output, and the hit rate between the first
 * two.
 *
 * Cumulative rather than last-request, to match the cost sitting next to it —
 * two adjacent numbers on different denominators is how a status line stops
 * being readable. The rate's denominator is the *input* side only; output tokens
 * are generated and can never be served from cache, so folding them in would
 * only ever drag the number down for a reason nobody can act on.
 */
export function statusUsageView(total: TokenUsage | undefined): StatusUsageView {
  if (!total) return { text: '', title: '' }
  const { inputTokens, cacheReadInputTokens, outputTokens } = total
  if (inputTokens === 0 && cacheReadInputTokens === 0 && outputTokens === 0) {
    return { text: '', title: '' }
  }

  const parts = [
    `入 ${formatTokens(inputTokens)}`,
    `命中 ${formatTokens(cacheReadInputTokens)}`,
    `出 ${formatTokens(outputTokens)}`,
  ]
  const titleLines = [
    `输入 ${formatExact(inputTokens)}（含缓存写入）`,
    `缓存命中 ${formatExact(cacheReadInputTokens)}`,
    `输出 ${formatExact(outputTokens)}`,
  ]

  const readSide = inputTokens + cacheReadInputTokens
  if (readSide > 0) {
    const rate = (cacheReadInputTokens / readSide) * 100
    parts.push(`命中率 ${rate.toFixed(1)}%`)
    titleLines.push(`命中率 ${rate.toFixed(1)}%（命中 / (输入 + 命中)）`)
  }

  return { text: parts.join(' · '), title: `本会话累计\n${titleLines.join('\n')}` }
}

export type ContextGaugeLevel = 'normal' | 'warn' | 'critical'

export interface ContextGaugeView {
  /** False when either number is missing; the gauge is absent rather than empty. */
  readonly visible: boolean
  /** Clamped to 0..1 — a turn may momentarily report more than the threshold. */
  readonly ratio: number
  readonly percent: string
  readonly level: ContextGaugeLevel
  /** Multi-line; folded into the chip's `title`. Empty when not visible. */
  readonly title: string
}

const HIDDEN: ContextGaugeView = Object.freeze({
  visible: false,
  ratio: 0,
  percent: '',
  level: 'normal' as const,
  title: '',
})

/** The "nothing to draw" gauge, so callers with no numbers yet need no `undefined` branch. */
export function hiddenContextGauge(): ContextGaugeView {
  return HIDDEN
}

/**
 * How full the context is, against the window that is *actually usable*.
 *
 * The denominator is `usableContextWindow` — the loop's autocompact threshold,
 * i.e. the raw window minus the summary's reserved output and the safety
 * buffer. That is the number the conversation is measured against in practice:
 * the turn that crosses it gets compacted, so a percentage of the raw window
 * would promise room that no turn is ever allowed to use. The raw window is
 * still reported, on its own line, as context for the reserve.
 */
export function contextGaugeView(
  used: number | undefined,
  runtime: WireRuntimeSnapshot | undefined,
): ContextGaugeView {
  const usable = runtime?.usableContextWindow
  if (used === undefined || usable === undefined || usable <= 0) return HIDDEN

  const ratio = Math.min(1, Math.max(0, used / usable))
  const percent = `${Math.round(ratio * 100)}%`
  const level: ContextGaugeLevel = ratio >= CONTEXT_CRITICAL_RATIO
    ? 'critical'
    : ratio >= CONTEXT_WARN_RATIO
      ? 'warn'
      : 'normal'

  const lines = [
    `上下文窗口：${percent} 已用（剩余 ${100 - Math.round(ratio * 100)}%）`,
    `已用 ${formatTokens(used)} 标记，共 ${formatTokens(usable)}（已预留自动压缩空间）`,
  ]
  if (runtime?.contextWindow !== undefined && runtime.contextWindow > usable) {
    lines.push(`模型窗口 ${formatTokens(runtime.contextWindow)}`)
  }

  return { visible: true, ratio, percent, level, title: lines.join('\n') }
}
