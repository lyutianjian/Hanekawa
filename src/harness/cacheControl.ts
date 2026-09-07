export interface CacheRuntime {
  settings?: {
    cache?: {
      ttl1h?: boolean
    }
  }
  env?: Record<string, string | undefined>
}

export function getCacheControl(runtime?: CacheRuntime): { type: 'ephemeral'; ttl?: '1h' } {
  return {
    type: 'ephemeral',
    ...(should1hCacheTTL(runtime) && { ttl: '1h' as const }),
  }
}

/**
 * Latched for the life of the process. A mid-session flip of the TTL changes the
 * shape of every `cache_control` marker we send, which is itself a cache break:
 * the server keys on the marker, so a settings reload that toggles `ttl1h` throws
 * away the whole cached prefix. Evaluate once, then stay put until an explicit
 * reset.
 */
let latchedTtl1h: boolean | undefined

export function should1hCacheTTL(runtime?: CacheRuntime): boolean {
  if (latchedTtl1h !== undefined) return latchedTtl1h
  latchedTtl1h = typeof runtime?.settings?.cache?.ttl1h === 'boolean'
    ? runtime.settings.cache.ttl1h
    : (runtime?.env ?? process.env).MYAGENT_PROMPT_CACHE_1H === '1'
  return latchedTtl1h
}

/** Clear the latched TTL so the next {@link should1hCacheTTL} re-evaluates. */
export function resetCacheTTLEvaluation(): void {
  latchedTtl1h = undefined
}

export function getPromptCachingEnabled(): boolean {
  if (process.env.MYAGENT_DISABLE_PROMPT_CACHING === '1') return false

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

/** Blocks the API refuses to accept a `cache_control` marker on. */
const UNCACHEABLE_BLOCK_TYPES = new Set(['thinking', 'redacted_thinking'])

/**
 * The block that carries the message-level cache write.
 *
 * The last block of the message, whatever its type — a turn that ends in
 * `tool_result` or `tool_use` is the common shape in an agent loop, and
 * requiring a `text` block there means those turns write no cache at all.
 * Thinking blocks are the one exception the API rejects, so walk back past them.
 */
function findBreakpointBlock(
  content: Array<Record<string, unknown>>,
): Record<string, unknown> | undefined {
  for (let index = content.length - 1; index >= 0; index--) {
    const block = content[index]
    if (!block || typeof block !== 'object') continue
    if (UNCACHEABLE_BLOCK_TYPES.has(block.type as string)) continue
    return block
  }
  return undefined
}

export function addCacheBreakpoints(
  messages: ContentMessage[],
  enablePromptCaching: boolean,
  runtime?: CacheRuntime,
): ContentMessage[] {
  if (!enablePromptCaching || messages.length === 0) return messages

  return messages.map((msg, index) => {
    if (index !== messages.length - 1) return msg

    const rawContent = Array.isArray(msg.content)
      ? msg.content
      : [{ type: 'text', text: msg.content }]

    if (rawContent.length === 0) return msg

    // Deep copy blocks so we don't mutate the original message objects.
    const content = rawContent.map((b) => ({ ...b }))

    const targetBlock = findBreakpointBlock(content)

    if (targetBlock) {
      targetBlock.cache_control = getCacheControl(runtime)
    }

    return { ...msg, content }
  })
}

export function addCacheControlToLastSystemBlock(
  blocks: TextBlockParam[],
  enablePromptCaching: boolean,
  runtime?: CacheRuntime,
): TextBlockParam[] {
  if (!enablePromptCaching || blocks.length === 0) return blocks.map((b) => ({ type: b.type, text: b.text }))

  const cacheCtrl = getCacheControl(runtime)
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
