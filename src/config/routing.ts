/**
 * Tiered model routing.
 *
 * Three layers of configuration:
 *  - endpoints:     provider + baseUrl + apiKey
 *  - models:        a model id + reference to an endpoint (or legacy inline endpoint fields)
 *  - profiles:      a tier -> model-key mapping (fast / balanced / powerful)
 *
 * Plus a `routing` map from semantic role to tier:
 *  - main:     the main loop
 *  - plan:     used while permissionMode === 'plan'
 *  - compact:  used by autoCompact and tool-use summarizer
 *  - subagent: per subagent_type (general / explore / plan / verification / fork / ...)
 *
 * The router accepts a `'inherit'` sentinel to mean "fall back to the parent /
 * main loop model", which is essential for fork-style sub-agents that share
 * the parent's prompt-cache stream.
 */

export type Tier = 'fast' | 'balanced' | 'powerful'

export type TierOrInherit = Tier | 'inherit'

export interface Endpoint {
  provider: string
  baseUrl?: string
  apiKey?: string
}

export type Profile = Partial<Record<Tier, string>>

export interface SubagentRouting {
  general?: TierOrInherit
  fork?: TierOrInherit
  explore?: TierOrInherit
  plan?: TierOrInherit
  verification?: TierOrInherit
  /** Custom subagent types declared via `.myagent/agents/*.md`. */
  [type: string]: TierOrInherit | undefined
}

export interface Routing {
  main?: TierOrInherit
  plan?: TierOrInherit
  compact?: TierOrInherit
  subagent?: SubagentRouting
}

/**
 * Default routing applied on top of any user-provided routing config.
 * Designed so a one-model setup degrades gracefully:
 * - When only `defaultModel` is configured (no profile / tiers), every role
 *   falls back to the default model via tier fallback in `resolveTier`.
 * - When all three tiers are configured, plan-mode automatically upgrades and
 *   compact / explore-style subagents downgrade.
 */
export const DEFAULT_ROUTING: Required<Pick<Routing, 'main' | 'plan' | 'compact'>> & { subagent: Required<Pick<SubagentRouting, 'general' | 'fork' | 'explore' | 'plan' | 'verification'>> } = {
  main: 'balanced',
  plan: 'powerful',
  compact: 'fast',
  subagent: {
    general: 'inherit',
    fork: 'inherit',
    explore: 'balanced',
    plan: 'powerful',
    verification: 'balanced',
  },
}

/**
 * Deep-merge user routing on top of defaults. Later sources override earlier.
 * `subagent` is merged key-by-key; missing keys keep defaults.
 */
export function mergeRouting(...sources: (Routing | undefined)[]): Routing {
  const result: Routing = {
    main: DEFAULT_ROUTING.main,
    plan: DEFAULT_ROUTING.plan,
    compact: DEFAULT_ROUTING.compact,
    subagent: { ...DEFAULT_ROUTING.subagent },
  }

  for (const source of sources) {
    if (!source) continue
    if (source.main !== undefined) result.main = source.main
    if (source.plan !== undefined) result.plan = source.plan
    if (source.compact !== undefined) result.compact = source.compact
    if (source.subagent) {
      result.subagent = { ...result.subagent, ...source.subagent }
    }
  }

  return result
}

/**
 * Resolve a tier to a concrete model key by walking a fallback chain.
 *
 * Why this shape:
 *   - `fast` requested but missing -> try balanced -> powerful (upgrade gracefully).
 *   - `balanced` -> powerful -> fast.
 *   - `powerful` -> balanced -> fast.
 * Returns undefined if the profile has no tiers populated; callers should
 * then fall back to `Config.defaultModel`.
 */
export function resolveTier(profile: Profile | undefined, tier: Tier): string | undefined {
  if (!profile) return undefined
  const order: Tier[] =
    tier === 'fast' ? ['fast', 'balanced', 'powerful']
    : tier === 'balanced' ? ['balanced', 'powerful', 'fast']
    : ['powerful', 'balanced', 'fast']
  for (const candidate of order) {
    const value = profile[candidate]
    if (value && value.trim() !== '') return value
  }
  return undefined
}

export type RoutingRole =
  | { kind: 'main' }
  | { kind: 'plan' }
  | { kind: 'compact' }
  | { kind: 'subagent'; type: string }

/**
 * Pick which tier a given role wants. Returns `'inherit'` to mean "use the
 * parent / main loop model directly", or a concrete `Tier`. Returns undefined
 * if the routing entry is not configured (caller should treat as 'inherit').
 */
export function pickTier(routing: Routing | undefined, role: RoutingRole): TierOrInherit | undefined {
  const r = routing ?? {}
  switch (role.kind) {
    case 'main':
      return r.main
    case 'plan':
      return r.plan
    case 'compact':
      return r.compact
    case 'subagent': {
      const subagent = r.subagent ?? {}
      // Type-specific override first, then fall through to general, then inherit.
      return subagent[role.type] ?? subagent.general ?? 'inherit'
    }
  }
}
