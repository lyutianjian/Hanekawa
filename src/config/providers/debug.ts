import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import type { ModelRequest } from '../../harness/types.js'
import { collectCacheControlTelemetry } from './cacheControlTelemetry.js'
import { normalizeAnthropicUsage, normalizeOpenAIUsage } from './usage.js'

function shouldDebugProviderPayloads() {
  return process.env.MYAGENT_DEBUG_PROVIDER === '1'
}

export function debugProviderPayload(label: string, payload: unknown) {
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

/**
 * `betas` is passed in rather than read off the payload: `anthropic-beta` is an
 * HTTP header, so it is nowhere in the request body and this is the only place
 * a running session can be seen to carry it.
 */
export function debugProviderSummary(
  label: string,
  request: ModelRequest,
  payload: unknown,
  betas?: string[],
) {
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
    ...(betas ? { betas } : {}),
    systemPresent: Boolean(request.system),
    toolNames,
    messageCount: request.messages.length,
    contextItemCount: request.contextItems?.length ?? 0,
    contextKinds,
    messagesPreview,
    payloadPreview,
    cacheControl: collectCacheControlTelemetry(payload),
    promptCacheKeyPresent: Boolean((payload as Record<string, unknown> | undefined)?.prompt_cache_key),
    promptCacheRetention: (payload as Record<string, unknown> | undefined)?.prompt_cache_retention,
  }, null, 2)}`)
}

export function debugProviderResponse(label: string, response: unknown) {
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
      cacheUsage: {
        uncachedInputTokens: typed.usage?.input_tokens ?? null,
        cacheCreationInputTokens: typed.usage?.cache_creation_input_tokens ?? null,
        cacheReadInputTokens: typed.usage?.cache_read_input_tokens ?? null,
      },
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
