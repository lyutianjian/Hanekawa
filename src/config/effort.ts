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
 * Normalize a configured `supportedEfforts` list.
 *
 * Dedupes, drops anything that is not a level, and sorts by {@link EFFORT_RANK}
 * so callers can read "the highest supported level" off the end. Empty and
 * "every level" both collapse to `undefined`, which is the one spelling of
 * "unrestricted" the rest of the code has to handle.
 */
export function normalizeSupportedEfforts(raw: unknown): EffortLevel[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const seen = new Set<EffortLevel>()
  for (const entry of raw) {
    if (typeof entry === 'string' && (VALID_EFFORT_LEVELS as readonly string[]).includes(entry)) {
      seen.add(entry as EffortLevel)
    }
  }
  if (seen.size === 0 || seen.size === VALID_EFFORT_LEVELS.length) return undefined
  return VALID_EFFORT_LEVELS.filter((level) => seen.has(level))
}

/** The levels a model accepts. An unrestricted model accepts all of them. */
export function supportedEffortLevels(
  supported: readonly EffortLevel[] | undefined,
): readonly EffortLevel[] {
  return supported && supported.length > 0 ? supported : VALID_EFFORT_LEVELS
}

export function isEffortSupported(
  level: EffortLevel,
  supported: readonly EffortLevel[] | undefined,
): boolean {
  return supportedEffortLevels(supported).includes(level)
}

/**
 * Move an effort onto a level the model actually accepts.
 *
 * A set rather than a ceiling because a model can refuse a level in the
 * *middle* of the ladder — `low` and `high` without `medium` is a real shape,
 * and a ceiling cannot say it. An unsupported level falls to the highest
 * supported level below it, or, when it is already below all of them, to the
 * lowest supported one. For a set that is a prefix of the ladder this is
 * exactly the old ceiling clamp.
 *
 * A numeric effort is a raw thinking budget with no position on the ladder, so
 * it passes through untouched.
 */
export function clampEffort(
  effort: EffortValue,
  supported: readonly EffortLevel[] | undefined,
): EffortValue {
  if (typeof effort === 'number') return effort
  const levels = supportedEffortLevels(supported)
  if (levels.includes(effort)) return effort
  const wanted = EFFORT_RANK[effort]
  let below: EffortLevel | undefined
  for (const level of levels) {
    if (EFFORT_RANK[level] < wanted) {
      if (below === undefined || EFFORT_RANK[level] > EFFORT_RANK[below]) below = level
    }
  }
  if (below !== undefined) return below
  let lowest = levels[0]!
  for (const level of levels) if (EFFORT_RANK[level] < EFFORT_RANK[lowest]) lowest = level
  return lowest
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
