export const VALID_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export type EffortLevel = (typeof VALID_EFFORT_LEVELS)[number]
export type EffortValue = EffortLevel | number

/** Numeric index for fallback comparison. Higher = more reasoning. */
export const EFFORT_RANK: Record<EffortLevel, number> = {
  low: 0,
  medium: 1,
  high: 2,
  xhigh: 3,
  max: 4,
}

export const DEFAULT_EFFORT: EffortLevel = 'high'

/**
 * Clamp effort to a model's max supported level.
 * Falls back through the chain: max → xhigh → high → medium → low.
 * If maxEffort is undefined, no clamping is applied.
 */
export function clampEffort(effort: EffortValue, maxEffort: EffortLevel | undefined): EffortValue {
  if (maxEffort === undefined) return effort
  if (typeof effort === 'number') return effort
  if (EFFORT_RANK[effort] > EFFORT_RANK[maxEffort]) return maxEffort
  return effort
}

/** Parse user input into a valid effort value, or undefined if invalid. */
export function parseEffortInput(input: string): EffortValue | undefined {
  const trimmed = input.trim().toLowerCase()
  if ((VALID_EFFORT_LEVELS as readonly string[]).includes(trimmed)) return trimmed as EffortLevel
  const num = parseInt(trimmed, 10)
  if (!isNaN(num) && num > 0) return num
  return undefined
}

/** Get human-readable description for an effort level. */
export function effortDescription(level: EffortLevel): string {
  switch (level) {
    case 'low': return 'Quick tasks, light reasoning, fastest responses'
    case 'medium': return 'Balanced approach, standard implementation'
    case 'high': return 'Thorough reasoning, comprehensive analysis (default)'
    case 'xhigh': return 'Deep reasoning, extensive analysis'
    case 'max': return 'Maximum capability, deepest reasoning'
  }
}
