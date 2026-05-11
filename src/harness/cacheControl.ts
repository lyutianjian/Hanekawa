export function getCacheControl(): { type: 'ephemeral'; ttl?: '1h' } {
  return {
    type: 'ephemeral',
    ...(should1hCacheTTL() && { ttl: '1h' as const }),
  }
}

let ttlOneHourEligible: boolean | null = null

export function should1hCacheTTL(): boolean {
  if (ttlOneHourEligible !== null) return ttlOneHourEligible
  ttlOneHourEligible = process.env.MYAGENT_PROMPT_CACHE_1H === '1'
  return ttlOneHourEligible
}

export function resetCacheTTLEvaluation(): void {
  ttlOneHourEligible = null
}

export function getPromptCachingEnabled(model?: string): boolean {
  if (process.env.MYAGENT_DISABLE_PROMPT_CACHING === '1') return false
  if (model?.includes('haiku') && process.env.MYAGENT_DISABLE_PROMPT_CACHING_HAIKU === '1') return false
  return true
}

interface TextBlockParam {
  type: 'text'
  text: string
  cache_control?: { type: 'ephemeral'; ttl?: '1h' }
}

interface ContentMessage {
  role?: string
  content?: string | Array<Record<string, unknown>>
  [key: string]: unknown
}

export function addCacheBreakpoints(
  messages: ContentMessage[],
  enablePromptCaching: boolean,
): ContentMessage[] {
  if (!enablePromptCaching || messages.length === 0) return messages

  const markerIndex = messages.length - 1

  return messages.map((msg, index) => {
    if (index !== markerIndex) return msg

    const content = Array.isArray(msg.content)
      ? [...msg.content]
      : [{ type: 'text', text: msg.content }]

    if (content.length === 0) return msg

    const lastBlock = content[content.length - 1] as Record<string, unknown>
    if (lastBlock && typeof lastBlock === 'object' && lastBlock.type === 'text') {
      lastBlock.cache_control = getCacheControl()
    }

    return { ...msg, content }
  })
}

export function addCacheControlToLastSystemBlock(
  blocks: TextBlockParam[],
  enablePromptCaching: boolean,
): TextBlockParam[] {
  if (!enablePromptCaching || blocks.length === 0) return blocks.map((b) => ({ type: b.type, text: b.text }))

  const cacheCtrl = getCacheControl()
  let marked = false

  const result = [...blocks].reverse().map((b) => {
    if (!marked && b.type === 'text') {
      marked = true
      return { type: b.type, text: b.text, cache_control: cacheCtrl }
    }
    return { type: b.type, text: b.text }
  }).reverse()

  return result
}

export const SYSTEM_PROMPT_DYNAMIC_BOUNDARY = '__MYAGENT_SYSTEM_PROMPT_DYNAMIC_BOUNDARY__'

export function splitSystemForCaching(systemBlocks: string[]): {
  staticBlocks: string[]
  dynamicBlocks: string[]
} {
  const boundaryIndex = systemBlocks.indexOf(SYSTEM_PROMPT_DYNAMIC_BOUNDARY)
  if (boundaryIndex < 0) {
    return { staticBlocks: [...systemBlocks], dynamicBlocks: [] }
  }
  return {
    staticBlocks: systemBlocks.slice(0, boundaryIndex),
    dynamicBlocks: systemBlocks.slice(boundaryIndex + 1),
  }
}
