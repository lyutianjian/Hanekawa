import OpenAI from 'openai'
import type { ModelConfig } from '../service.js'
import type { ModelProvider, ModelRequest, ModelResponse } from '../../harness/types.js'
import {
  checkResponseForCacheBreak,
  recordPromptState,
  requireCacheSource,
  type CacheBreakResult,
} from '../../harness/cacheBreakDetection.js'
import { withRetry } from '../retry.js'
import { safeJsonParse } from '../../utils/json.js'
import { debugProviderPayload, debugProviderResponse, debugProviderSummary } from './debug.js'
import { buildOpenAIPayload, getOpenAICacheScope } from './openaiPayload.js'
import { normalizeOpenAIUsage } from './usage.js'

export class OpenAIProvider implements ModelProvider {
  name = 'openai'
  private client: OpenAI

  constructor(config: ModelConfig) {
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
    })
  }

  supportsDynamicToolSearch(): boolean {
    return false
  }

  async createMessage(request: ModelRequest): Promise<ModelResponse> {
    return withRetry(
      async (attempt) => {
        const effectiveRequest: ModelRequest = {
          ...request,
        }
        const payload = buildOpenAIPayload(effectiveRequest)
        const cacheSource = requireCacheSource(effectiveRequest.cacheSource)
        recordPromptState({
          system: JSON.stringify(getOpenAISystemFromPayload(payload)),
          toolsJson: JSON.stringify(getOpenAIToolsFromPayload(payload)),
          model: String(payload.model ?? effectiveRequest.model),
          cacheScope: getOpenAICacheScope(effectiveRequest),
        }, cacheSource)
        if (attempt > 1) {
          debugProviderPayload('openai-retry', payload)
        }
        debugProviderSummary('openai', effectiveRequest, payload)
        debugProviderPayload('openai', payload)
        const response = await this.client.chat.completions.create(payload, {
          signal: request.retry?.signal,
          ...(request.retry?.signal ? {} : { timeout: 120_000 }),
        })
        debugProviderResponse('openai', response)

        if (!response.choices || response.choices.length === 0) {
          throw new Error('OpenAI API returned empty choices array — possible content filtering or upstream error')
        }

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
        const usage = normalizeOpenAIUsage(response.usage)
        let cacheBreak: CacheBreakResult | null = null
        if (response.usage) {
          cacheBreak = checkResponseForCacheBreak(
            usage.cacheReadInputTokens,
            usage.inputTokens,
            cacheSource,
          )
        }

        return {
          content,
          toolCalls,
          usage,
          requestId: response.id,
          stopReason: normalizeOpenAIStopReason(choice?.finish_reason),
          ...(reasoning ? { reasoningContent: reasoning } : {}),
          ...(cacheBreak ? { cacheBreak } : {}),
        }
      },
      {
        maxRetries: request.retry?.maxRetries,
        callerKind: request.retry?.callerKind ?? 'interactive',
        persistent: request.retry?.persistent,
        signal: request.retry?.signal,
      },
    )
  }
}

function getOpenAISystemFromPayload(payload: ReturnType<typeof buildOpenAIPayload>): unknown {
  const systemMessage = payload.messages.find((message) => message.role === 'system')
  return systemMessage?.content ?? ''
}

function getOpenAIToolsFromPayload(payload: ReturnType<typeof buildOpenAIPayload>): unknown {
  return 'tools' in payload ? payload.tools : []
}

function normalizeOpenAIStopReason(reason: string | null | undefined): string | undefined {
  if (reason === 'length') return 'max_tokens'
  return reason ?? undefined
}
