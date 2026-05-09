import type { ModelContextItem, ModelProvider, ModelRequest, ModelResponse, Tool } from '../harness/types.js'
import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import type { ModelConfig } from './service.js'

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
    maxTokens: request.maxTokens ?? 4096,
    toolNames,
    messageCount: request.messages.length,
    contextItemCount: request.contextItems?.length ?? 0,
    contextKinds,
    messagesPreview,
    payloadPreview,
  }, null, 2)}`)
}

function debugProviderResponse(label: string, response: unknown) {
  if (!shouldDebugProviderPayloads()) return
  if (label === 'anthropic') {
    const typed = response as Anthropic.Messages.Message
    const textBlocks = typed.content.filter((item) => item.type === 'text')
    const toolBlocks = typed.content.filter((item) => item.type === 'tool_use')
    console.error(`[myagent][provider:${label}] response summary ${JSON.stringify({
      id: typed.id,
      model: typed.model,
      stopReason: typed.stop_reason,
      contentTypes: typed.content.map((item) => item.type),
      textLength: textBlocks.reduce((sum, item) => sum + (item.type === 'text' ? item.text.length : 0), 0),
      toolCalls: toolBlocks.map((item) => item.type === 'tool_use' ? item.name : undefined).filter(Boolean),
    }, null, 2)}`)
    return
  }

  const typed = response as OpenAI.Chat.ChatCompletion
  const message = typed.choices[0]?.message
  console.error(`[myagent][provider:${label}] response summary ${JSON.stringify({
    id: typed.id,
    model: typed.model,
    finishReason: typed.choices[0]?.finish_reason,
    textLength: typeof message?.content === 'string' ? message.content.length : 0,
    toolCalls: message?.tool_calls?.map((call) => {
      const fn = call as { function?: { name?: string } }
      return fn.function?.name
    }) ?? [],
  }, null, 2)}`)
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
        content: item.message.content,
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

export function buildAnthropicPayload(request: ModelRequest) {
  const tools = buildAnthropicTools(request.tools)
  return {
    model: request.model,
    max_tokens: request.maxTokens ?? 4096,
    messages: buildAnthropicMessages(request) as unknown as Anthropic.Messages.MessageParam[],
    ...(request.system ? { system: request.system } : {}),
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
    ...(tools.length > 0
      ? {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          tools: tools as any,
        }
      : {}),
  }
}

export class AnthropicProvider implements ModelProvider {
  name = 'anthropic'
  private client: Anthropic

  constructor(config: ModelConfig) {
    this.client = new Anthropic({
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
    })
  }

  async createMessage(request: ModelRequest): Promise<ModelResponse> {
    const payload = buildAnthropicPayload(request)
    debugProviderSummary('anthropic', request, payload)
    debugProviderPayload('anthropic', payload)
    const response = await this.client.messages.create(payload)
    debugProviderResponse('anthropic', response)

    const content = response.content.find((c) => c.type === 'text')
    const toolUses = response.content.filter((c) => c.type === 'tool_use')

    let textContent = content?.type === 'text' ? content.text : ''

    // Normalize: if there are tool uses and content is only whitespace, clear it
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
    }
  }
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
    const response = await this.client.chat.completions.create(payload)
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
