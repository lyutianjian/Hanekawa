import type Anthropic from '@anthropic-ai/sdk'
import type { ModelContextItem, ModelRequest, Tool } from '../../harness/types.js'
import { getCachedToolSchema } from '../../harness/toolApiSchema.js'
import {
  addCacheBreakpoints,
  type CacheRuntime,
  getCacheControl,
  getPromptCachingEnabled,
  splitSystemForCaching,
} from '../../harness/cacheControl.js'
import {
  ANTHROPIC_CACHE_CONTROL_LIMIT,
  assertAnthropicCacheControlLimit,
  collectCacheControlTelemetry,
} from './cacheControlTelemetry.js'
import { getModelCapabilityOrDefault, CAPPED_DEFAULT_MAX_TOKENS, isSlotCapDisabled } from '../../prompts/modelCapabilities.js'

const MAX_OUTPUT_TOKENS_DEFAULT = 32_000
const MAX_OUTPUT_TOKENS_UPPER_LIMIT = 128_000
const EXTENDED_CACHE_TTL_BETA = 'extended-cache-ttl-2025-04-11'
const TOOL_SEARCH_BETA = 'advanced-tool-use-2025-11-20'
const CACHE_EDITING_BETA = 'cache-editing-2025-04-11'
/** The 1M context window. Opt-in per model — see `ModelConfig.longContext1m`. */
export const CONTEXT_1M_BETA = 'context-1m-2025-08-07'

export function getMaxOutputTokens(configValue?: number, model?: string): number {
  const envValue = process.env.MYAGENT_MAX_OUTPUT_TOKENS
  if (envValue) {
    const parsed = parseInt(envValue, 10)
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.min(parsed, MAX_OUTPUT_TOKENS_UPPER_LIMIT)
    }
  }
  const num = typeof configValue === 'number' ? configValue : Number(configValue)
  if (Number.isFinite(num) && num > 0) {
    return Math.min(num, MAX_OUTPUT_TOKENS_UPPER_LIMIT)
  }
  // Model-aware default with slot cap: reduce over-reservation.
  // p99 output is ~4,911 tokens; 32k/64k defaults over-reserve 8-16x.
  // Requests hitting this cap get one retry at ESCALATED_MAX_TOKENS (64k).
  if (model) {
    const cap = getModelCapabilityOrDefault(model)
    if (isSlotCapDisabled()) return cap.defaultMaxOutputTokens
    return Math.min(cap.defaultMaxOutputTokens, CAPPED_DEFAULT_MAX_TOKENS)
  }
  if (isSlotCapDisabled()) return MAX_OUTPUT_TOKENS_DEFAULT
  return Math.min(MAX_OUTPUT_TOKENS_DEFAULT, CAPPED_DEFAULT_MAX_TOKENS)
}

function anthropicContent(content: string): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text', text: content }]
}

function findLastUserMessageIndex(messages: Array<Record<string, unknown>>): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user') return i
  }
  return -1
}

function anthropicSystemWithCache(request: ModelRequest): Array<{ type: 'text'; text: string; cache_control?: { type: 'ephemeral'; ttl?: '1h' } }> {
  const { staticBlocks, dynamicBlocks } = splitSystemForCaching(
    request.systemBlocks ?? (request.system ? [request.system] : []),
  )
  const enableCaching = getPromptCachingEnabled()

  const staticText = staticBlocks.join('\n\n')
  const blocks: Array<{ type: 'text'; text: string; cache_control?: { type: 'ephemeral'; ttl?: '1h' } }> = []

  if (staticText) {
    blocks.push({
      type: 'text',
      text: staticText,
      ...(enableCaching ? { cache_control: getCacheControl(request.cacheRuntime) } : {}),
    })
  }
  for (const b of dynamicBlocks) {
    blocks.push({ type: 'text', text: b })
  }

  return blocks.filter((b) => b.text.length > 0)
}

export function buildAnthropicMessages(request: ModelRequest) {
  const contextItems = request.contextItems ?? request.messages.map((message) => ({ kind: 'message', message }) satisfies ModelContextItem)
  const messages: Array<Record<string, unknown>> = []
  let pendingToolResults: Array<Record<string, unknown>> = []

  for (const item of contextItems) {
    if (item.kind === 'message') {
      if (pendingToolResults.length > 0) {
        messages.push({ role: 'user', content: pendingToolResults })
        pendingToolResults = []
      }
      if (item.message.role !== 'user' && item.message.role !== 'assistant') continue
      const content = anthropicContent(item.message.content).filter((block) => {
        if (block.type === 'text') return block.text.trim() !== ''
        return true
      })

      if (item.message.role === 'assistant' && item.message.thinkingBlocks && item.message.thinkingBlocks.length > 0) {
        const thinkingBlocks = item.message.thinkingBlocks.map((block) => {
          if (block.type === 'redacted_thinking') {
            return { type: 'redacted_thinking', data: block.data }
          }
          return { type: 'thinking', thinking: block.thinking ?? '', signature: block.signature ?? '' }
        })
        const merged = [...thinkingBlocks, ...content] as Array<Record<string, unknown>>
        if (merged.length === 0) continue
        messages.push({
          role: item.message.role,
          content: merged,
        })
        continue
      }

      if (content.length === 0) continue
      messages.push({
        role: item.message.role,
        content,
      })
      continue
    }

    if (item.kind === 'tool_use') {
      const lastMessage = messages[messages.length - 1]
      const toolUseBlock = {
        type: 'tool_use',
        id: item.id,
        name: item.tool,
        input: item.input,
      }
      if (lastMessage && lastMessage.role === 'assistant') {
        const existingContent = lastMessage.content as unknown[]
        const contentArray = Array.isArray(existingContent)
          ? existingContent
          : typeof existingContent === 'string'
            ? anthropicContent(existingContent)
            : [existingContent]

        const filteredContent = contentArray.filter((block) => {
          if (typeof block === 'string') {
            return block.trim() !== ''
          }
          if (typeof block === 'object' && block !== null && 'text' in block) {
            const text = (block as { text?: unknown }).text
            return typeof text === 'string' && text.trim() !== ''
          }
          return true
        })

        lastMessage.content = [...filteredContent, toolUseBlock]
      } else {
        messages.push({
          role: 'assistant',
          content: [toolUseBlock],
        })
      }
      continue
    }

    // Use pre-mapped API block when available (e.g. tool_reference for ToolSearch),
    // otherwise fall back to plain-text content.
    if (item.apiResultBlock) {
      pendingToolResults.push({
        ...(item.apiResultBlock as unknown as Record<string, unknown>),
        is_error: !item.ok,
      })
    } else {
      pendingToolResults.push({
        type: 'tool_result',
        tool_use_id: item.toolUseId,
        content: item.content,
        is_error: !item.ok,
      })
    }
  }

  if (pendingToolResults.length > 0) {
    messages.push({ role: 'user', content: pendingToolResults })
  }

  // --- Cache edits injection ---
  if (request.pendingCacheEdits && messages.length > 0) {
    const lastUserIdx = findLastUserMessageIndex(messages)
    if (lastUserIdx >= 0) {
      const msg = messages[lastUserIdx]
      const content = Array.isArray(msg.content) ? [...msg.content] : [{ type: 'text', text: String(msg.content) }]
      content.push(request.pendingCacheEdits as unknown as Record<string, unknown>)
      messages[lastUserIdx] = { ...msg, content }
    }
  }

  // Re-insert pinned edits at their original positions
  if (request.pinnedCacheEdits) {
    for (const pinned of request.pinnedCacheEdits) {
      const msg = messages[pinned.userMessageIndex]
      if (msg && msg.role === 'user') {
        const content = Array.isArray(msg.content) ? [...msg.content] : [{ type: 'text', text: String(msg.content) }]
        // Deduplicate: skip if cache_edits with same refs already exist
        const existingRefs = new Set(
          content
            .filter((b: Record<string, unknown>) => b.type === 'cache_edits')
            .flatMap((b: Record<string, unknown>) => (b.edits as Array<{ cache_reference: string }>).map(e => e.cache_reference))
        )
        const newEdits = pinned.block.edits.filter(e => !existingRefs.has(e.cache_reference))
        if (newEdits.length > 0) {
          content.push({ type: 'cache_edits', edits: newEdits })
        }
        messages[pinned.userMessageIndex] = { ...msg, content }
      }
    }
  }

  // Add cache_reference to tool_result blocks in the cached prefix
  // (all messages except the last one, which has the cache_edits)
  if (request.pendingCacheEdits) {
    for (let i = 0; i < messages.length - 1; i++) {
      const msg = messages[i]
      const msgContent = msg.content as unknown
      if (msg.role !== 'user' || !Array.isArray(msgContent)) continue
      const contentArr = msgContent as Array<Record<string, unknown>>
      let cloned = false
      for (let j = 0; j < contentArr.length; j++) {
        const block = contentArr[j]
        if (block && block.type === 'tool_result' && block.tool_use_id) {
          if (!cloned) {
            msg.content = [...contentArr]
            cloned = true
          }
          ;((msg.content as Array<Record<string, unknown>>)[j]).cache_reference = block.tool_use_id
        }
      }
    }
  }

  if (messages.length === 0) {
    messages.push({ role: 'user', content: anthropicContent('(context truncated - please continue)') })
  }

  return messages
}

export function buildAnthropicTools(
  tools: Tool[] = [],
  enablePromptCaching = false,
  runtime?: CacheRuntime,
  deferredToolNames?: Set<string>,
) {
  return tools.map((tool, index) => {
    // Get cached base schema (name + description + input_schema)
    const base = getCachedToolSchema(tool)
    // Apply per-request overlays (not cached; vary per call)
    return {
      ...base,
      ...(deferredToolNames?.has(tool.name) ? { defer_loading: true } : {}),
      ...(enablePromptCaching && index === tools.length - 1
        ? { cache_control: getCacheControl(runtime) }
        : {}),
    }
  })
}

export function buildAnthropicPayload(request: ModelRequest, maxOutputTokens?: number, nativeAnthropic = false) {
  const enableCaching = nativeAnthropic && getPromptCachingEnabled()
  const dynamicToolSearch = nativeAnthropic && request.hasDeferredTools === true
  // Only tools discovered AFTER the last compaction should have defer_loading.
  // Pre-compact discovered tools have lost their tool_reference blocks in the
  // message history, so the API can't expand them; send them as regular tools.
  const deferLoadingNames = dynamicToolSearch
    ? (request.postCompactDiscoveredNames ?? new Set<string>())
    : undefined
  // ALL deferred tool names from the full (unfiltered) tool list for <available-deferred-tools>.
  const allDeferredNames = request.allDeferredToolNames
  const tools = buildAnthropicTools(request.tools, enableCaching, request.cacheRuntime, deferLoadingNames)
  let messages = buildAnthropicMessages(request)
  const systemBlocks = request.systemBlocks ?? (request.system ? [request.system] : [])

  // Inject <available-deferred-tools> as the first user message.
  // Uses ALL deferred tool names (not just discovered ones) so the model
  // knows the full set of tools available via ToolSearch.
  if (dynamicToolSearch && allDeferredNames && allDeferredNames.size > 0) {
    const deferredList = [...allDeferredNames].sort().join('\n')
    messages = [
      { role: 'user', content: `<available-deferred-tools>\n${deferredList}\n</available-deferred-tools>` },
      ...messages,
    ]
  }

  // Build thinking config: adaptive by default, or from request
  let thinking: { type: 'adaptive' } | { type: 'enabled'; budget_tokens: number } | undefined
  if (request.thinking?.type === 'enabled') {
    thinking = { type: 'enabled', budget_tokens: request.thinking.budgetTokens }
  } else if (request.thinking?.type === 'disabled') {
    thinking = undefined
  } else {
    // Default: adaptive thinking
    thinking = { type: 'adaptive' }
  }

  const maxOutput = getMaxOutputTokens(maxOutputTokens ?? request.maxOutputTokens, request.model)
  const thinkingBudget = thinking?.type === 'enabled' ? thinking.budget_tokens : 0
  const finalMaxOutput = thinkingBudget > 0 && maxOutput <= thinkingBudget
    ? thinkingBudget + 1024
    : maxOutput

  // Build output_config with effort if specified
  const outputConfig = request.effort
    ? { effort: request.effort }
    : undefined

  const payload = {
    model: request.model,
    max_tokens: finalMaxOutput,
    messages: nativeAnthropic
      ? addCacheBreakpoints(messages, enableCaching, request.cacheRuntime) as unknown as Anthropic.Messages.MessageParam[]
      : messages as unknown as Anthropic.Messages.MessageParam[],
    ...(systemBlocks.length > 0
      ? {
          system: nativeAnthropic
            ? anthropicSystemWithCache(request) as unknown as Anthropic.Messages.MessageCreateParams['system']
            : systemBlocks.join('\n\n'),
        }
      : {}),
    ...(tools.length > 0
      ? {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          tools: tools as any,
          ...(nativeAnthropic ? { tool_choice: { type: 'auto' } as const } : {}),
        }
      : {}),
    ...(thinking ? { thinking } : {}),
    ...(outputConfig ? { output_config: outputConfig } : {}),
    ...(nativeAnthropic && request.contextManagement
      ? { context_management: request.contextManagement }
      : {}),
  }

  return nativeAnthropic ? finalizeAnthropicCacheControl(payload) : payload
}

export interface AnthropicBetaOptions {
  /** `ModelConfig.longContext1m` for the model this request runs on. */
  longContext1m?: boolean
}

export function getAnthropicBetaHeaders(
  request: ModelRequest,
  nativeAnthropic = false,
  options: AnthropicBetaOptions = {},
): string[] {
  const betas: string[] = []
  // The one beta not gated on `nativeAnthropic`. The switch exists precisely for
  // the compatible endpoints that only expose their 1M models when this header
  // is present, and their `baseUrl` is by definition not anthropic.com.
  if (options.longContext1m) betas.push(CONTEXT_1M_BETA)
  if (nativeAnthropic && getPromptCachingEnabled()) {
    if (getCacheControl(request.cacheRuntime).ttl === '1h') {
      betas.push(EXTENDED_CACHE_TTL_BETA)
    }
  }
  if (nativeAnthropic && request.hasDeferredTools) {
    betas.push(TOOL_SEARCH_BETA)
  }
  if (nativeAnthropic && request.pendingCacheEdits && request.pendingCacheEdits.edits.length > 0) {
    betas.push(CACHE_EDITING_BETA)
  }
  return betas
}

export function getAnthropicCacheScope(request: ModelRequest, nativeAnthropic = false): string {
  if (!nativeAnthropic || !getPromptCachingEnabled()) return 'disabled'
  return getCacheControl(request.cacheRuntime).ttl === '1h' ? 'ephemeral:1h' : 'ephemeral:5m'
}

export function enforceAnthropicCacheControlLimit<T extends Record<string, unknown>>(payload: T): T {
  let remaining = collectCacheControlTelemetry(payload).total - ANTHROPIC_CACHE_CONTROL_LIMIT
  if (remaining <= 0) return payload

  remaining = removeCacheControlMarkers(payload.tools, remaining)
  remaining = removeCacheControlMarkers(payload.messages, remaining)
  removeCacheControlMarkers(payload.system, remaining)

  return payload
}

function finalizeAnthropicCacheControl<T extends Record<string, unknown>>(payload: T): T {
  enforceAnthropicCacheControlLimit(payload)
  const telemetry = assertAnthropicCacheControlLimit(payload)
  if (process.env.MYAGENT_DEBUG_PROVIDER === '1') {
    console.error(`[myagent][prompt-cache] cache_control markers ${JSON.stringify(telemetry)}`)
  }
  return payload
}

function removeCacheControlMarkers(value: unknown, remaining: number): number {
  if (remaining <= 0) return 0
  if (Array.isArray(value)) {
    for (let index = value.length - 1; index >= 0 && remaining > 0; index--) {
      remaining = removeCacheControlMarkers(value[index], remaining)
    }
    return remaining
  }
  if (!isRecord(value)) return remaining

  if (Object.hasOwn(value, 'cache_control')) {
    delete value.cache_control
    remaining -= 1
  }

  for (const item of Object.values(value).reverse()) {
    if (remaining <= 0) break
    remaining = removeCacheControlMarkers(item, remaining)
  }

  return remaining
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
