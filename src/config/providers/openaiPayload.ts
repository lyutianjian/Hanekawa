import { createHash } from 'node:crypto'
import OpenAI from 'openai'
import type { ModelContextItem, ModelRequest, Tool } from '../../harness/types.js'
import { toolToAPISchema } from '../../harness/toolApiSchema.js'

export function buildOpenAIMessages(request: ModelRequest): OpenAI.Chat.ChatCompletionMessageParam[] {
  const contextItems = request.contextItems ?? request.messages.map((message) => ({ kind: 'message', message }) satisfies ModelContextItem)
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    ...(request.system ? [{ role: 'system' as const, content: request.system }] : []),
  ]

  for (const item of contextItems) {
    if (item.kind === 'message') {
      if (item.message.role !== 'user' && item.message.role !== 'assistant') continue
      const message: OpenAI.Chat.ChatCompletionMessageParam & { reasoning_content?: string } = {
        role: item.message.role,
        content: item.message.content,
      }
      if (item.message.role === 'assistant' && item.message.reasoningContent) {
        message.reasoning_content = item.message.reasoningContent
      }
      messages.push(message)
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

    // Use apiResultBlock content when available (e.g. ToolSearch schemas text for OpenAI)
    const toolContent = item.apiResultBlock
      ? (typeof item.apiResultBlock.content === 'string' ? item.apiResultBlock.content : item.content)
      : item.content
    messages.push({
      role: 'tool',
      content: toolContent,
      tool_call_id: item.toolUseId,
    })
  }

  return messages
}

export function buildOpenAITools(tools: Tool[] = []) {
  return tools.map((tool) => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: toolToAPISchema(tool) as Record<string, unknown>,
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

export function getOpenAICacheScope(request: ModelRequest): string {
  return `openai:${request.promptCacheRetention ?? 'default'}`
}

export function buildOpenAIPayload(request: ModelRequest) {
  const tools = buildOpenAITools(request.tools)
  return {
    model: request.model,
    messages: buildOpenAIMessages(request),
    ...(request.maxOutputTokens ? { max_tokens: request.maxOutputTokens } : {}),
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
