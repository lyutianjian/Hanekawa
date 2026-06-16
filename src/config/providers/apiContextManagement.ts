/**
 * Server-side context management strategies for the Anthropic API.
 *
 * When enabled, the API automatically clears old tool results and/or
 * thinking blocks when input_tokens exceed a configured threshold.
 * This reduces the need for client-side micro-compact.
 *
 * Reference: Anthropic context_management API field.
 */

// --- Strategy types (match Anthropic API schema) ---

export type ContextEditStrategy =
  | {
      type: 'clear_tool_uses_20250919'
      trigger?: {
        type: 'input_tokens'
        value: number
      }
      keep?: {
        type: 'tool_uses'
        value: number
      }
      clear_tool_inputs?: boolean | string[]
      exclude_tools?: string[]
      clear_at_least?: {
        type: 'input_tokens'
        value: number
      }
    }
  | {
      type: 'clear_thinking_20251015'
      keep: { type: 'thinking_turns'; value: number } | 'all'
    }

export type APISideContextManagement = {
  edits: ContextEditStrategy[]
}

// --- Configuration ---

export interface APISideContextManagementConfig {
  /** Master switch — when false, no strategies are sent. */
  enabled: boolean
  /** input_tokens threshold that triggers server-side clearing. */
  triggerTokens: number
  /** Target input_tokens to keep after clearing. */
  targetTokens: number
  /** Enable server-side thinking block clearing. */
  clearThinking: boolean
  /** Enable server-side tool result clearing (requires MYAGENT_API_CLEAR_TOOL_RESULTS=1). */
  clearToolResults: boolean
}

export const DEFAULT_API_CONTEXT_MANAGEMENT_CONFIG: APISideContextManagementConfig = {
  enabled: process.env.MYAGENT_API_CONTEXT_MANAGEMENT === '1',
  triggerTokens: 180_000,
  targetTokens: 40_000,
  clearThinking: true,
  clearToolResults: process.env.MYAGENT_API_CLEAR_TOOL_RESULTS === '1',
}

// --- Tool name lists ---

/** Tools whose tool_result blocks can be cleared server-side. */
const CLEARABLE_RESULT_TOOLS: readonly string[] = [
  'Bash',
  'Glob',
  'Grep',
  'Read',
  'WebFetch',
  'WebSearch',
]

/** Tools whose tool_use blocks can be cleared server-side. */
const CLEARABLE_USE_TOOLS: readonly string[] = [
  'Edit',
  'Write',
  'NotebookEdit',
]

// --- Builder ---

export interface APIContextManagementOptions {
  /** Whether the current request includes thinking blocks. */
  hasThinking?: boolean
  /** Whether the idle gap exceeds the cache-expiry threshold (~60min). */
  clearAllThinking?: boolean
  /** Runtime config overrides. */
  config?: Partial<APISideContextManagementConfig>
}

/**
 * Build the context_management strategies for an Anthropic API request.
 *
 * Returns `undefined` when no strategies should be sent (feature disabled,
 * or no applicable strategies for the current request state).
 */
export function getAPIContextManagement(
  options?: APIContextManagementOptions,
): APISideContextManagement | undefined {
  const config = { ...DEFAULT_API_CONTEXT_MANAGEMENT_CONFIG, ...options?.config }

  if (!config.enabled) return undefined

  const strategies: ContextEditStrategy[] = []

  // Thinking clearing: always applicable when the request has thinking blocks.
  // When clearAllThinking is true (idle > 60min, cache expired), keep only
  // the last thinking turn — the API requires value >= 1.
  if (config.clearThinking && options?.hasThinking) {
    strategies.push({
      type: 'clear_thinking_20251015',
      keep: options.clearAllThinking
        ? { type: 'thinking_turns', value: 1 }
        : 'all',
    })
  }

  // Tool result clearing: clear old tool_result blocks when input_tokens
  // exceed the trigger threshold. Only sent when explicitly enabled via env var
  // to avoid unnecessary API overhead on small contexts.
  if (config.clearToolResults) {
    strategies.push({
      type: 'clear_tool_uses_20250919',
      trigger: {
        type: 'input_tokens',
        value: config.triggerTokens,
      },
      clear_at_least: {
        type: 'input_tokens',
        value: config.triggerTokens - config.targetTokens,
      },
      clear_tool_inputs: [...CLEARABLE_RESULT_TOOLS],
    })
  }

  return strategies.length > 0 ? { edits: strategies } : undefined
}
