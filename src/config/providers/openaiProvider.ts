import OpenAI from 'openai'
import type { ModelConfig } from '../service.js'
import type { ModelProvider, ModelRequest, ModelResponse } from '../../harness/types.js'
import { requireCacheSource } from '../../harness/cacheBreakDetection.js'
import { withRetry } from '../retry.js'
import { safeJsonParse } from '../../utils/json.js'
import { debugProviderPayload, debugProviderResponse, debugProviderSummary } from './debug.js'
import { buildOpenAIPayload } from './openaiPayload.js'
import { normalizeOpenAIUsage } from './usage.js'

export class OpenAIProvider implements ModelProvider {
  name = 'openai'
  private client: OpenAI
  private thinkingConfig: { enabled: boolean; budgetTokens?: number } | undefined

  constructor(config: ModelConfig) {
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
    })
    this.thinkingConfig = config.thinking
  }

  async createMessage(request: ModelRequest): Promise<ModelResponse> {
    return withRetry(
      async (attempt) => {
        const effectiveRequest: ModelRequest = {
          ...request,
          thinking: request.thinking ?? this.thinkingConfig,
        }
        requireCacheSource(effectiveRequest.cacheSource)
        const payload = buildOpenAIPayload(effectiveRequest)
        if (attempt > 1) {
          debugProviderPayload('openai-retry', payload)
        }
        debugProviderSummary('openai', effectiveRequest, payload)
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
              input: safeJsonParse(fn.function.arguments),
            }
          }) ?? []

        let content = message?.content ?? ''
        if (toolCalls.length > 0 && typeof content === 'string' && content.trim() === '') {
          content = ''
        }

        const reasoningContent = (message as { reasoning_content?: unknown } | undefined)?.reasoning_content
        const reasoning = typeof reasoningContent === 'string' && reasoningContent.length > 0
          ? reasoningContent
          : undefined

        return {
          content,
          toolCalls,
          usage: normalizeOpenAIUsage(response.usage),
          requestId: response.id,
          stopReason: choice?.finish_reason ?? undefined,
          ...(reasoning ? { reasoningContent: reasoning } : {}),
        }
      },
      {
        maxRetries: request.retry?.maxRetries ?? 3,
        callerKind: request.retry?.callerKind ?? 'interactive',
        signal: request.retry?.signal,
      },
    )
  }
}
