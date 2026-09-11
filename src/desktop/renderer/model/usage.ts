import type { TokenUsage } from '../../../harness/types.js'
import type { WireRuntimeSnapshot } from '../../../runtime/protocol/wire.js'

/**
 * The two token readouts under and beside the composer.
 *
 * Pure, like `model/composer.ts`: `dom/statusView.ts` and `dom/composerView.ts`
 * only turn what these return into nodes.
 *
 * The status line prints one count, not three: `总计 X tok · 缓存命中 Y%`. It
 * carried a chip per direction for a while (`输入` / `缓存命中` / `输出`), which
 * is three figures to add up before the line answers the question it is actually
 * asked — how much this session has spent. The split survives in the hover for
 * anyone who wants it.
 *
 * `cache_creation` is deliberately not broken out:
 * `normalizeAnthropicUsage` folds cache writes into `inputTokens`, and splitting
 * them out here would mean a new field on `TokenUsage` — which is persisted in
 * every session's JSONL. The total therefore means "everything billed, cache
 * writes included", which is also what the cost beside it is computed from.
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

/**
 * Which count a chip carries — the view turns this into a glyph.
 *
 * One kind, kept as a union rather than collapsed away: the chip, its icon map
 * and its CSS hook are all keyed by it, and a second count coming back later
 * should be a new member here rather than a second shape of chip.
 */
export type UsageMetricKind = 'total'

export interface UsageMetric {
  readonly kind: UsageMetricKind
  /** `53.4M tok`, already abbreviated and carrying its unit. */
  readonly value: string
  /** What the glyph stands for, for the accessible name. */
  readonly label: string
}

/**
 * The cache hit rate: a written-out label and its percentage.
 *
 * The one field on this line that is *not* a glyph and a figure. It was a swept
 * ring for a while, which put a second ratio dial on the same screen as the
 * context indicator's — two rings, two meanings, one shape. A rate is also the
 * one number here that no mark explains on its own, so it carries its name.
 */
export interface UsageRateView {
  readonly label: string
  readonly percent: string
}

export interface StatusUsageView {
  /**
   * Empty while nothing has been counted, so `#status` collapses to no height.
   * The chips the view draws; the numbers are never a single string on screen.
   */
  readonly metrics: readonly UsageMetric[]
  /** Absent when nothing has been read at all — no denominator, no rate. */
  readonly rate: UsageRateView | undefined
  /** The same line as one string, for the readout's accessible name. */
  readonly text: string
  /** The same numbers unabbreviated, for the hover. Empty when `text` is. */
  readonly title: string
}

const EMPTY: StatusUsageView = Object.freeze({
  metrics: [],
  rate: undefined,
  text: '',
  title: '',
})

/**
 * The session's total token spend, and the cache hit rate beside it.
 *
 * Cumulative rather than last-request, to match the cost sitting next to it —
 * two adjacent numbers on different denominators is how a status line stops
 * being readable. The rate's denominator is the *input* side only; output tokens
 * are generated and can never be served from cache, so folding them in would
 * only ever drag the number down for a reason nobody can act on.
 */
export function statusUsageView(total: TokenUsage | undefined): StatusUsageView {
  if (!total) return EMPTY
  const { inputTokens, cacheReadInputTokens, outputTokens } = total
  const allTokens = inputTokens + cacheReadInputTokens + outputTokens
  if (allTokens === 0) return EMPTY

  const metrics: UsageMetric[] = [
    { kind: 'total', value: `${formatTokens(allTokens)} tok`, label: '总计' },
  ]
  const titleLines = [
    `总计 ${formatExact(allTokens)} 标记`,
    `输入 ${formatExact(inputTokens)}（含缓存写入）`,
    `缓存命中 ${formatExact(cacheReadInputTokens)}`,
    `输出 ${formatExact(outputTokens)}`,
  ]

  const parts = metrics.map((metric) => `${metric.label} ${metric.value}`)
  const readSide = inputTokens + cacheReadInputTokens
  let rate: UsageRateView | undefined
  if (readSide > 0) {
    const percentage = (cacheReadInputTokens / readSide) * 100
    rate = { label: '缓存命中', percent: `${percentage.toFixed(1)}%` }
    parts.push(`${rate.label} ${rate.percent}`)
    titleLines.push(`${rate.label} ${rate.percent}（命中 / (输入 + 命中)）`)
  }

  return {
    metrics,
    rate,
    text: parts.join(' · '),
    title: `本会话累计\n${titleLines.join('\n')}`,
  }
}

export type ContextGaugeLevel = 'normal' | 'warn' | 'critical'

export interface ContextGaugeView {
  /** False when either number is missing; the gauge is absent rather than empty. */
  readonly visible: boolean
  /** Clamped to 0..1 — a turn may momentarily report more than the threshold. */
  readonly ratio: number
  readonly percent: string
  readonly level: ContextGaugeLevel
  /** Formatted for the indicator's structured tooltip. Empty when not visible. */
  readonly used: string
  readonly usable: string
  readonly modelWindow: string | undefined
  /** Multi-line, for the indicator's accessible name. Empty when not visible. */
  readonly title: string
}

const HIDDEN: ContextGaugeView = Object.freeze({
  visible: false,
  ratio: 0,
  percent: '',
  level: 'normal' as const,
  used: '',
  usable: '',
  modelWindow: undefined,
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

  const usedText = formatTokens(used)
  const usableText = formatTokens(usable)
  const modelWindow = runtime?.contextWindow !== undefined && runtime.contextWindow > usable
    ? formatTokens(runtime.contextWindow)
    : undefined

  const ratio = Math.min(1, Math.max(0, used / usable))
  const percent = `${Math.round(ratio * 100)}%`
  const level: ContextGaugeLevel = ratio >= CONTEXT_CRITICAL_RATIO
    ? 'critical'
    : ratio >= CONTEXT_WARN_RATIO
      ? 'warn'
      : 'normal'

  const lines = [
    `上下文窗口：${percent} 已用（剩余 ${100 - Math.round(ratio * 100)}%）`,
    `已用 ${usedText} 标记，共 ${usableText}（已预留自动压缩空间）`,
  ]
  if (modelWindow) lines.push(`模型窗口 ${modelWindow}`)

  return {
    visible: true,
    ratio,
    percent,
    level,
    used: usedText,
    usable: usableText,
    modelWindow,
    title: lines.join('\n'),
  }
}
