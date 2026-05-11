import type { ModelContextItem, ModelProvider, ModelRequest, ModelResponse, TokenUsage, Tool } from '../harness/types.js'
import { createHash } from 'node:crypto'
import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import type { ModelConfig } from './service.js'
import {
  addCacheBreakpoints,
  addCacheControlToLastSystemBlock,
  getPromptCachingEnabled,
  splitSystemForCaching,
} from '../harness/cacheControl.js'
import { withRetry, isRetryableError } from './retry.js'

const MAX_OUTPUT_TOKENS_DEFAULT = 32_000
const MAX_OUTPUT_TOKENS_UPPER_LIMIT = 128_000

function getMaxOutputTokens(configValue?: number): number {
  const envValue = process.env.MYAGENT_MAX_OUTPUT_TOKENS
  if (envValue) {
    const parsed = parseInt(envValue, 10)
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.min(parsed, MAX_OUTPUT_TOKENS_UPPER_LIMIT)
    }
  }
  if (configValue !== undefined && Number.isFinite(configValue) && configValue > 0) {
    return Math.min(configValue, MAX_OUTPUT_TOKENS_UPPER_LIMIT)
  }
  return MAX_OUTPUT_TOKENS_DEFAULT
}

function anthropicContent(content: string): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text', text: content }]
}

function anthropicSystem(request: ModelRequest): Array<{ type: 'text'; text: string }> {
  const blocks = request.systemBlocks && request.systemBlocks.length > 0
    ? request.systemBlocks
    : request.system
      ? [request.system]
      : []

  return blocks.map((b) => ({ type: 'text', text: b }))
}

function anthropicSystemWithCache(request: ModelRequest): Array<{ type: 'text'; text: string; cache_control?: { type: 'ephemeral'; ttl?: '1h' } }> {
  const { staticBlocks, dynamicBlocks } = splitSystemForCaching(
    request.systemBlocks ?? (request.system ? [request.system] : []),
  )
  const enableCaching = getPromptCachingEnabled(request.model)

  const staticText = staticBlocks.join('\n\n')
  const blocks: Array<{ type: 'text'; text: string; cache_control?: { type: 'ephemeral'; ttl?: '1h' } }> = []

  if (staticText) {
    blocks.push({ type: 'text', text: staticText })
  }
  for (const b of dynamicBlocks) {
    blocks.push({ type: 'text', text: b })
  }

  return addCacheControlToLastSystemBlock(
    blocks.filter((b) => b.text.length > 0),
    enableCaching,
  )
}

function shouldDebugProviderPayloads() {
  return process.env.MYAGENT_DEBUG_PROVIDER === '1'
}

function debugProviderPayload(label: string, payload: unknown) {
  if (!shouldDebugProviderPayloads()) return
  console.error(`[myagent][provider:${label}] payload\n${JSON.stringify(payload, null, 2)}`)
}

function previewContent(value: unknown): string {
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === 'string') return `text:${item.slice(0, 80)}`
        if (item && typeof item === 'object' && 'type' in item) {
          const typed = item as Record<string, unknown>
          if (typed.type === 'tool_use') return `tool_use:${String(typed.name ?? '')}`
          if (typed.type === 'tool_result') return `tool_result:${String(typed.tool_use_id ?? '')}`
          if (typed.type === 'text') return `text:${String(typed.text ?? '').slice(0, 80)}`
          return String(typed.type)
        }
        return typeof item
      })
      .join(', ')
  }
  if (typeof value === 'string') return value.slice(0, 120)
  return typeof value
}

function debugProviderSummary(label: string, request: ModelRequest, payload: unknown) {
  if (!shouldDebugProviderPayloads()) return
  const toolNames = (request.tools ?? []).map((tool) => tool.name)
  const contextKinds = (request.contextItems ?? []).map((item) => item.kind)
  const messagesPreview = request.messages.map((message) => `${message.role}:${message.content.slice(0, 60)}`)
  let payloadPreview: unknown
  if (payload && typeof payload === 'object') {
    const candidate = payload as Record<string, unknown>
    const payloadMessages = Array.isArray(candidate.messages) ? candidate.messages : []
    payloadPreview = payloadMessages.map((message) => {
      const typed = message as Record<string, unknown>
      return {
        role: typed.role,
        content: previewContent(typed.content),
      }
    })
  }

  console.error(`[myagent][provider:${label}] request summary ${JSON.stringify({
    model: request.model,
    systemPresent: Boolean(request.system),
    toolNames,
    messageCount: request.messages.length,
    contextItemCount: request.contextItems?.length ?? 0,
    contextKinds,
    messagesPreview,
    payloadPreview,
    promptCacheKeyPresent: Boolean((payload as Record<string, unknown> | undefined)?.prompt_cache_key),
    promptCacheRetention: (payload as Record<string, unknown> | undefined)?.prompt_cache_retention,
  }, null, 2)}`)
}

function debugProviderResponse(label: string, response: unknown) {
  if (!shouldDebugProviderPayloads()) return
  if (label === 'anthropic') {
    const typed = response as Anthropic.Messages.Message
    const textBlocks = typed.content.filter((item) => item.type === 'text')
    const toolBlocks = typed.content.filter((item) => item.type === 'tool_use')
    const usage = normalizeAnthropicUsage(typed.usage)
    console.error(`[myagent][provider:${label}] response summary ${JSON.stringify({
      id: typed.id,
      model: typed.model,
      stopReason: typed.stop_reason,
      contentTypes: typed.content.map((item) => item.type),
      textLength: textBlocks.reduce((sum, item) => sum + (item.type === 'text' ? item.text.length : 0), 0),
      toolCalls: toolBlocks.map((item) => item.type === 'tool_use' ? item.name : undefined).filter(Boolean),
      usage,
    }, null, 2)}`)
    return
  }

  const typed = response as OpenAI.Chat.ChatCompletion
  const message = typed.choices[0]?.message
  const usage = normalizeOpenAIUsage(typed.usage)
  console.error(`[myagent][provider:${label}] response summary ${JSON.stringify({
    id: typed.id,
    model: typed.model,
    finishReason: typed.choices[0]?.finish_reason,
    textLength: typeof message?.content === 'string' ? message.content.length : 0,
    usage,
    toolCalls: message?.tool_calls?.map((call) => {
      const fn = call as { function?: { name?: string } }
      return fn.function?.name
    }) ?? [],
  }, null, 2)}`)
}

function tokenNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

export function normalizeAnthropicUsage(usage: unknown): TokenUsage {
  const typed = usage && typeof usage === 'object' ? usage as Record<string, unknown> : {}
  return {
    inputTokens: tokenNumber(typed.input_tokens) + tokenNumber(typed.cache_creation_input_tokens),
    cacheReadInputTokens: tokenNumber(typed.cache_read_input_tokens),
    outputTokens: tokenNumber(typed.output_tokens),
  }
}

export function normalizeOpenAIUsage(usage: unknown): TokenUsage {
  const typed = usage && typeof usage === 'object' ? usage as Record<string, unknown> : {}
  const details = typed.prompt_tokens_details && typeof typed.prompt_tokens_details === 'object'
    ? typed.prompt_tokens_details as Record<string, unknown>
    : {}
  const cacheReadInputTokens = tokenNumber(details.cached_tokens)
  const promptTokens = tokenNumber(typed.prompt_tokens)
  return {
    inputTokens: Math.max(0, promptTokens - cacheReadInputTokens),
    cacheReadInputTokens,
    outputTokens: tokenNumber(typed.completion_tokens),
  }
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
      messages.push({
        role: item.message.role,
        content: anthropicContent(item.message.content),
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

    pendingToolResults.push({
      type: 'tool_result',
      tool_use_id: item.toolUseId,
      content: item.content,
      is_error: !item.ok,
    })
  }

  if (pendingToolResults.length > 0) {
    messages.push({ role: 'user', content: pendingToolResults })
  }

  return messages
}

export function buildOpenAIMessages(request: ModelRequest): OpenAI.Chat.ChatCompletionMessageParam[] {
  const contextItems = request.contextItems ?? request.messages.map((message) => ({ kind: 'message', message }) satisfies ModelContextItem)
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    ...(request.system ? [{ role: 'system' as const, content: request.system }] : []),
  ]

  for (const item of contextItems) {
    if (item.kind === 'message') {
      if (item.message.role !== 'user' && item.message.role !== 'assistant') continue
      messages.push({
        role: item.message.role,
        content: item.message.content,
      })
      continue
    }

    if (item.kind === 'tool_use') {
      const lastMessage = messages[messages.length - 1]
      const toolCall = {
        id: item.id,
        type: 'function' as const,
        function: {
          name: item.tool,
          arguments: JSON.stringify(item.input ?? {}),
        },
      }
      if (lastMessage && lastMessage.role === 'assistant') {
        const existing = (lastMessage as { tool_calls?: unknown[] }).tool_calls ?? []
        ;(lastMessage as { tool_calls: unknown[] }).tool_calls = [...existing, toolCall]
        if (typeof lastMessage.content === 'string' && lastMessage.content.trim() === '') {
          lastMessage.content = ''
        }
      } else {
        messages.push({
          role: 'assistant',
          content: '',
          tool_calls: [toolCall],
        })
      }
      continue
    }

    messages.push({
      role: 'tool',
      content: item.content,
      tool_call_id: item.toolUseId,
    })
  }

  return messages
}

export function buildAnthropicTools(tools: Tool[] = []) {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
  }))
}

export function buildOpenAITools(tools: Tool[] = []) {
  return tools.map((tool) => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema as Record<string, unknown>,
    },
  }))
}

export function buildOpenAIPromptCacheKey(request: ModelRequest): string {
  const tools = buildOpenAITools(request.tools).map((tool) => ({
    name: tool.function.name,
    description: tool.function.description,
    parameters: tool.function.parameters,
  }))
  const hash = createHash('sha256')
    .update(JSON.stringify({
      model: request.model,
      system: request.system ?? '',
      tools,
    }))
    .digest('hex')
    .slice(0, 32)

  return `myagent:${hash}`
}

export function buildAnthropicPayload(request: ModelRequest, maxOutputTokens?: number) {
  const tools = buildAnthropicTools(request.tools)
  const enableCaching = getPromptCachingEnabled(request.model)
  const messages = buildAnthropicMessages(request)

  return {
    model: request.model,
    max_tokens: getMaxOutputTokens(maxOutputTokens ?? request.maxOutputTokens),
    messages: addCacheBreakpoints(
      messages,
      enableCaching,
    ) as unknown as Anthropic.Messages.MessageParam[],
    ...(request.system || request.systemBlocks?.length
      ? { system: anthropicSystemWithCache(request) as unknown as Anthropic.Messages.MessageCreateParams['system'] }
      : {}),
    ...(tools.length > 0
      ? {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          tools: tools as any,
          tool_choice: { type: 'auto', disable_parallel_tool_use: true } as const,
        }
      : {}),
  }
}

export function buildOpenAIPayload(request: ModelRequest) {
  const tools = buildOpenAITools(request.tools)
  return {
    model: request.model,
    messages: buildOpenAIMessages(request),
    prompt_cache_key: buildOpenAIPromptCacheKey(request),
    ...(request.promptCacheRetention ? { prompt_cache_retention: request.promptCacheRetention } : {}),
    ...(tools.length > 0
      ? {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          tools: tools as any,
        }
      : {}),
  }
}

const STREAM_IDLE_TIMEOUT_MS =
  parseInt(process.env.MYAGENT_STREAM_IDLE_TIMEOUT_MS || '', 10) || 90_000

export class AnthropicProvider implements ModelProvider {
  name = 'anthropic'
  private client: Anthropic
  private maxOutputTokens: number | undefined

  constructor(config: ModelConfig) {
    this.client = new Anthropic({
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
    })
    this.maxOutputTokens = config.maxOutputTokens
  }

  async createMessage(request: ModelRequest): Promise<ModelResponse> {
    return withRetry(
      async (attempt) => {
        const payload = buildAnthropicPayload(request, this.maxOutputTokens)
        if (attempt > 1) {
          debugProviderPayload('anthropic-retry', payload)
        }
        debugProviderSummary('anthropic', request, payload)
        debugProviderPayload('anthropic', payload)

        let response: Anthropic.Messages.Message
        try {
          const stream = this.client.messages.stream(
            payload as unknown as Anthropic.Messages.MessageStreamParams,
          )
          response = await streamWithTimeout(stream)
        } catch (streamError) {
          if (isStreamTimeoutError(streamError)) {
            return await this.executeNonStreamingRequest(payload, request)
          }
          throw streamError
        }

        debugProviderResponse('anthropic', response)
        return this.parseResponse(response)
      },
      {
        maxRetries: request.retry?.maxRetries ?? 3,
        shouldRetry: (error) => isRetryableError(error),
        signal: request.retry?.signal,
      },
    )
  }

  private parseResponse(response: Anthropic.Messages.Message): ModelResponse {
    const content = response.content.find((c) => c.type === 'text')
    const toolUses = response.content.filter((c) => c.type === 'tool_use')

    let textContent = content?.type === 'text' ? content.text : ''

    if (toolUses.length > 0 && textContent.trim() === '') {
      textContent = ''
    }

    return {
      content: textContent,
      toolCalls: toolUses.map((c) => {
        if (c.type !== 'tool_use') throw new Error('Unexpected content type')
        return {
          id: c.id,
          name: c.name,
          input: c.input,
        }
      }),
      usage: normalizeAnthropicUsage(response.usage),
      requestId: response.id,
      stopReason: response.stop_reason ?? undefined,
    }
  }

  private async executeNonStreamingRequest(
    payload: Record<string, unknown>,
    request: ModelRequest,
  ): Promise<ModelResponse> {
    const nonStreamingPayload = {
      ...payload,
      stream: false,
      max_tokens: Math.min(
        (payload.max_tokens as number) ?? 32_000,
        64_000,
      ),
    }
    debugProviderPayload('anthropic-nonstreaming', nonStreamingPayload)

    const response = await this.client.messages.create(
      nonStreamingPayload as unknown as Anthropic.Messages.MessageCreateParamsNonStreaming,
    )
    debugProviderResponse('anthropic', response)
    return this.parseResponse(response)
  }
}

function isStreamTimeoutError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('Stream idle timeout')
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function streamWithTimeout(
  stream: { finalMessage: () => Promise<Anthropic.Messages.Message> },
): Promise<Anthropic.Messages.Message> {
  return Promise.race([
    stream.finalMessage(),
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('Stream idle timeout')), STREAM_IDLE_TIMEOUT_MS)
    }),
  ])
}

export class OpenAIProvider implements ModelProvider {
  name = 'openai'
  private client: OpenAI

  constructor(config: ModelConfig) {
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
    })
  }

  async createMessage(request: ModelRequest): Promise<ModelResponse> {
    const payload = buildOpenAIPayload(request)
    debugProviderSummary('openai', request, payload)
    debugProviderPayload('openai', payload)
    const response = await this.client.chat.completions.create(payload, {
      signal: request.retry?.signal,
    })
    debugProviderResponse('openai', response)

    const choice = response.choices[0]
    const message = choice?.message

    const toolCalls =
      message?.tool_calls?.map((tc) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const fn = tc as any
        return {
          id: tc.id,
          name: fn.function.name,
          input: typeof fn.function.arguments === 'string'
            ? JSON.parse(fn.function.arguments)
            : fn.function.arguments,
        }
      }) ?? []

    let content = message?.content ?? ''
    if (toolCalls.length > 0 && typeof content === 'string' && content.trim() === '') {
      content = ''
    }

    return {
      content,
      toolCalls,
      usage: normalizeOpenAIUsage(response.usage),
      requestId: response.id,
      stopReason: choice?.finish_reason ?? undefined,
    }
  }
}

export class ProviderRegistry {
  private providers: Map<string, ModelProvider> = new Map()

  register(provider: ModelProvider): void {
    this.providers.set(provider.name, provider)
  }

  get(name: string): ModelProvider | undefined {
    return this.providers.get(name)
  }

  has(name: string): boolean {
    return this.providers.has(name)
  }

  list(): string[] {
    return Array.from(this.providers.keys())
  }
}

export function createProvider(config: ModelConfig): ModelProvider | undefined {
  switch (config.provider) {
    case 'anthropic':
      return new AnthropicProvider(config)
    case 'openai':
      return new OpenAIProvider(config)
    default:
      return undefined
  }
}
