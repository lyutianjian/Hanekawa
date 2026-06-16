export const MODEL_CONTEXT_WINDOW_DEFAULT = 200_000
export const MODEL_CONTEXT_WINDOW_1M = 1_000_000
export const CAPPED_DEFAULT_MAX_TOKENS = 8_000
export const ESCALATED_MAX_TOKENS = 64_000

export interface ModelCapability {
  contextWindow: number
  defaultMaxOutputTokens: number
  upperMaxOutputTokens: number
}

// Patterns checked in order; first match wins.
// More specific patterns (e.g. 'sonnet-4-6') MUST come before general ones
// (e.g. 'sonnet-4') to avoid false positives.
const MODEL_CAPABILITIES: Array<{ pattern: string; capability: ModelCapability }> = [
  // Claude 4.6 family
  { pattern: 'opus-4-6',   capability: { contextWindow: 200_000, defaultMaxOutputTokens: 64_000, upperMaxOutputTokens: 128_000 } },
  { pattern: 'sonnet-4-6', capability: { contextWindow: 200_000, defaultMaxOutputTokens: 32_000, upperMaxOutputTokens: 128_000 } },
  // Claude 4.5 / 4.x family
  { pattern: 'opus-4-5',   capability: { contextWindow: 200_000, defaultMaxOutputTokens: 32_000, upperMaxOutputTokens: 64_000 } },
  { pattern: 'haiku-4',    capability: { contextWindow: 200_000, defaultMaxOutputTokens: 32_000, upperMaxOutputTokens: 64_000 } },
  { pattern: 'sonnet-4',   capability: { contextWindow: 200_000, defaultMaxOutputTokens: 32_000, upperMaxOutputTokens: 64_000 } },
  // Claude 4.0 / 4.1
  { pattern: 'opus-4-1',   capability: { contextWindow: 200_000, defaultMaxOutputTokens: 32_000, upperMaxOutputTokens: 32_000 } },
  { pattern: 'opus-4',     capability: { contextWindow: 200_000, defaultMaxOutputTokens: 32_000, upperMaxOutputTokens: 32_000 } },
  // Claude 3.x family
  { pattern: 'claude-3-opus',   capability: { contextWindow: 200_000, defaultMaxOutputTokens: 4_096, upperMaxOutputTokens: 4_096 } },
  { pattern: 'claude-3-sonnet', capability: { contextWindow: 200_000, defaultMaxOutputTokens: 8_192, upperMaxOutputTokens: 8_192 } },
  { pattern: 'claude-3-haiku',  capability: { contextWindow: 200_000, defaultMaxOutputTokens: 4_096, upperMaxOutputTokens: 4_096 } },
  { pattern: '3-5-sonnet',      capability: { contextWindow: 200_000, defaultMaxOutputTokens: 8_192, upperMaxOutputTokens: 8_192 } },
  { pattern: '3-5-haiku',       capability: { contextWindow: 200_000, defaultMaxOutputTokens: 8_192, upperMaxOutputTokens: 8_192 } },
  { pattern: '3-7-sonnet',      capability: { contextWindow: 200_000, defaultMaxOutputTokens: 32_000, upperMaxOutputTokens: 64_000 } },
]

const DEFAULT_CAPABILITY: ModelCapability = {
  contextWindow: MODEL_CONTEXT_WINDOW_DEFAULT,
  defaultMaxOutputTokens: 32_000,
  upperMaxOutputTokens: 64_000,
}

export function getModelCapability(model: string): ModelCapability | undefined {
  const canonical = model.toLowerCase()
  for (const entry of MODEL_CAPABILITIES) {
    if (canonical.includes(entry.pattern)) {
      return entry.capability
    }
  }
  return undefined
}

export function getContextWindowFromModelKey(modelKey: string | undefined): number | undefined {
  return modelKey?.trim().toLowerCase().endsWith('[1m]')
    ? MODEL_CONTEXT_WINDOW_1M
    : undefined
}

export function isSlotCapDisabled(): boolean {
  return process.env.MYAGENT_SLOT_CAP_DISABLED === '1'
}

export function getModelCapabilityOrDefault(model: string): ModelCapability {
  return getModelCapability(model) ?? DEFAULT_CAPABILITY
}
