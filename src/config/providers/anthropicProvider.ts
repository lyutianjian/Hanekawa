import Anthropic from '@anthropic-ai/sdk'
import type { ModelConfig } from '../service.js'
import type { ModelProvider, ModelRequest, ModelResponse, ThinkingBlock } from '../../harness/types.js'
import {
  checkResponseForCacheBreak,
  recordPromptState,
  requireCacheSource,
  type CacheBreakResult,
} from '../../harness/cacheBreakDetection.js'
import { withRetry } from '../retry.js'
import { buildAnthropicPayload, getAnthropicBetaHeaders, getAnthropicCacheScope } from './anthropicPayload.js'
import { debugProviderPayload, debugProviderResponse, debugProviderSummary } from './debug.js'
import { normalizeAnthropicUsage } from './usage.js'

const STREAM_IDLE_TIMEOUT_MS =
  parseInt(process.env.MYAGENT_STREAM_IDLE_TIMEOUT_MS || '', 10) || 90_000

function isNativeAnthropicApi(baseUrl?: string): boolean {
  if (!baseUrl) return true
  return baseUrl.includes('anthropic.com')
}

export class AnthropicProvider implements ModelProvider {
  name = 'anthropic'
  private client: Anthropic
  private maxOutputTokens: number | undefined
  private nativeAnthropic: boolean
  private thinkingConfig: { enabled: boolean; budgetTokens?: number } | undefined

  constructor(config: ModelConfig) {
    this.client = new Anthropic({
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
    })
    this.maxOutputTokens = config.maxOutputTokens
    this.nativeAnthropic = isNativeAnthropicApi(config.baseUrl)
    this.thinkingConfig = config.thinking
  }

  async createMessage(request: ModelRequest): Promise<ModelResponse> {
    return withRetry(
      async (attempt) => {
        const effectiveRequest: ModelRequest = {
          ...request,
          thinking: request.thinking ?? this.thinkingConfig,
        }
        const payload = buildAnthropicPayload(effectiveRequest, this.maxOutputTokens, this.nativeAnthropic)
        const cacheSource = requireCacheSource(effectiveRequest.cacheSource)
        if (this.nativeAnthropic) {
          recordPromptState({
            system: JSON.stringify(payload.system ?? ''),
            toolsJson: JSON.stringify(payload.tools ?? []),
            model: effectiveRequest.model,
            betas: getAnthropicBetaHeaders(effectiveRequest, this.nativeAnthropic),
            cacheScope: getAnthropicCacheScope(effectiveRequest, this.nativeAnthropic),
          }, cacheSource)
        }
        if (attempt > 1) {
          debugProviderPayload('anthropic-retry', payload)
        }
        debugProviderSummary('anthropic', request, payload)
        debugProviderPayload('anthropic', payload)

        const stream = this.client.messages.stream(
          payload as unknown as Anthropic.Messages.MessageStreamParams,
        )
        let response: Anthropic.Messages.Message
        try {
          response = await streamWithTimeout(stream, request.retry?.signal)
        } catch (error) {
          if (!isStreamIdleTimeout(error)) {
            throw error
          }
          response = await this.executeNonStreamingRequest(payload)
        }

        debugProviderResponse('anthropic', response)
        const parsed = this.parseResponse(response)
        let cacheBreak: CacheBreakResult | null = null
        if (this.nativeAnthropic && parsed.usage) {
          cacheBreak = checkResponseForCacheBreak(
            parsed.usage.cacheReadInputTokens,
            parsed.usage.inputTokens,
            cacheSource,
          )
        }
        return {
          ...parsed,
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

  private parseResponse(response: Anthropic.Messages.Message): ModelResponse {
    // Concatenate ALL text blocks — the API can return multiple text blocks
    // (e.g., text before and after tool use in the same message).
    const textBlocks = response.content.filter((c) => c.type === 'text')
    const toolUses = response.content.filter((c) => c.type === 'tool_use')
    const thinkingBlocks: ThinkingBlock[] = response.content
      .filter((c) => c.type === 'thinking' || c.type === 'redacted_thinking')
      .map((c) => {
        if (c.type === 'thinking') {
          return {
            type: 'thinking' as const,
            thinking: (c as { thinking?: string }).thinking ?? '',
            signature: (c as { signature?: string }).signature ?? '',
          }
        }
        return {
          type: 'redacted_thinking' as const,
          data: (c as { data?: string }).data ?? '',
        }
      })

    let textContent = textBlocks.map((c) => c.type === 'text' ? c.text : '').join('')

    if (toolUses.length > 0 && textContent.trim() === '') {
      textContent = ''
    }

    return {
      content: textContent,
      toolCalls: toolUses.map((c) => {
        if (c.type !== 'tool_use') throw new Error('Unexpected content type')
        let input = c.input
        if (typeof input === 'string') {
          try { input = JSON.parse(input) } catch { /* keep as-is */ }
        }
        return {
          id: c.id,
          name: c.name,
          input,
        }
      }),
      usage: normalizeAnthropicUsage(response.usage),
      requestId: response.id,
      stopReason: response.stop_reason ?? undefined,
      ...(thinkingBlocks.length > 0 ? { thinkingBlocks } : {}),
    }
  }

  private async executeNonStreamingRequest(
    payload: Record<string, unknown>,
  ): Promise<Anthropic.Messages.Message> {
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
    return response
  }
}

function isStreamIdleTimeout(error: unknown): boolean {
  return error instanceof Error && error.message === 'Stream idle timeout'
}

type AnthropicMessageStream = {
  finalMessage: () => Promise<Anthropic.Messages.Message>
  abort: () => void
  on: (event: 'streamEvent', listener: (...args: unknown[]) => void) => unknown
  off: (event: 'streamEvent', listener: (...args: unknown[]) => void) => unknown
}

export async function streamWithTimeout(
  stream: AnthropicMessageStream,
  signal?: AbortSignal,
  idleTimeoutMs = STREAM_IDLE_TIMEOUT_MS,
): Promise<Anthropic.Messages.Message> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const resetTimer = () => {
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(() => {
      stream.abort()
      rejectTimeout(new Error('Stream idle timeout'))
    }, idleTimeoutMs)
  }
  let rejectTimeout: (error: Error) => void = () => {}
  const timeoutPromise = new Promise<never>((_, reject) => {
    rejectTimeout = reject
  })
  stream.on('streamEvent', resetTimer)
  resetTimer()

  let onAbort: (() => void) | undefined
  const abortPromise = signal
    ? new Promise<never>((_, reject) => {
        if (signal.aborted) {
          stream.abort()
          reject(new DOMException('The operation was aborted.', 'AbortError'))
          return
        }
        onAbort = () => {
          stream.abort()
          reject(new DOMException('The operation was aborted.', 'AbortError'))
        }
        signal.addEventListener('abort', onAbort, { once: true })
      })
    : null

  try {
    const racers: Promise<Anthropic.Messages.Message>[] = [stream.finalMessage(), timeoutPromise]
    if (abortPromise) racers.push(abortPromise)
    return await Promise.race(racers)
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    stream.off('streamEvent', resetTimer)
    if (signal && onAbort) signal.removeEventListener('abort', onAbort)
  }
}
