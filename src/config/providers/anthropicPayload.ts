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

const MAX_OUTPUT_TOKENS_DEFAULT = 32_000
const MAX_OUTPUT_TOKENS_UPPER_LIMIT = 128_000
const EXTENDED_CACHE_TTL_BETA = 'extended-cache-ttl-2025-04-11'

function getMaxOutputTokens(configValue?: number): number {
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
  return MAX_OUTPUT_TOKENS_DEFAULT
}

function anthropicContent(content: string): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text', text: content }]
}

function anthropicSystemWithCache(request: ModelRequest): Array<{ type: 'text'; text: string; cache_control?: { type: 'ephemeral'; ttl?: '1h' } }> {
  const { staticBlocks, dynamicBlocks } = splitSystemForCaching(
    request.systemBlocks ?? (request.system ? [request.system] : []),
  )
  const enableCaching = getPromptCachingEnabled(request.model)

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
        ...(item.apiResultBlock as Record<string, unknown>),
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
    // Apply per-request overlays (not cached — vary per call)
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
  const enableCaching = nativeAnthropic && getPromptCachingEnabled(request.model)
  // Only tools discovered AFTER the last compaction should have defer_loading.
  // Pre-compact discovered tools have lost their tool_reference blocks in the
  // message history, so the API can't expand them — send them as regular tools.
  const deferLoadingNames = request.hasDeferredTools
    ? (request.postCompactDiscoveredNames ?? new Set<string>())
    : undefined
  // ALL deferred tool names from the full (unfiltered) tool list — for <available-deferred-tools>
  const allDeferredNames = request.allDeferredToolNames
  const tools = buildAnthropicTools(request.tools, enableCaching, request.cacheRuntime, deferLoadingNames)
  let messages = buildAnthropicMessages(request)
  const systemBlocks = request.systemBlocks ?? (request.system ? [request.system] : [])

  // Inject <available-deferred-tools> as the first user message.
  // Uses ALL deferred tool names (not just discovered ones) so the model
  // knows the full set of tools available via ToolSearch.
  if (allDeferredNames && allDeferredNames.size > 0) {
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

  const maxOutput = getMaxOutputTokens(maxOutputTokens ?? request.maxOutputTokens)
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
  }

  return nativeAnthropic ? finalizeAnthropicCacheControl(payload) : payload
}

export function getAnthropicBetaHeaders(request: ModelRequest, nativeAnthropic = false): string[] {
  const betas: string[] = []
  if (nativeAnthropic && getPromptCachingEnabled(request.model)) {
    if (getCacheControl(request.cacheRuntime).ttl === '1h') {
      betas.push(EXTENDED_CACHE_TTL_BETA)
    }
  }
  if (request.hasDeferredTools) {
    betas.push('tool-reference-2025-04-14')
  }
  return betas
}

export function getAnthropicCacheScope(request: ModelRequest, nativeAnthropic = false): string {
  if (!nativeAnthropic || !getPromptCachingEnabled(request.model)) return 'disabled'
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
