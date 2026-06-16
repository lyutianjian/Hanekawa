import Anthropic from '@anthropic-ai/sdk'
import type { ModelConfig } from '../service.js'
import type { ModelProvider, ModelRequest, ModelResponse, ModelStreamEvent, ThinkingBlock } from '../../harness/types.js'
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
import { isExperimentalToolSearchBetaDisabled, modelSupportsToolReference } from '../../utils/toolSearch.js'

const STREAM_IDLE_TIMEOUT_MS =
  parseInt(process.env.MYAGENT_STREAM_IDLE_HARD_TIMEOUT_MS || '', 10) || 10 * 60_000
const STREAM_IDLE_WARNING_MS =
  parseInt(
    process.env.MYAGENT_STREAM_IDLE_WARNING_MS
      || process.env.MYAGENT_STREAM_IDLE_TIMEOUT_MS
      || '',
    10,
  ) || 90_000

function isNativeAnthropicApi(baseUrl?: string): boolean {
  if (!baseUrl) return true
  return baseUrl.includes('anthropic.com')
}

export class AnthropicProvider implements ModelProvider {
  name = 'anthropic'
  private client: Anthropic
  private maxOutputTokens: number | undefined
  private nativeAnthropic: boolean

  constructor(config: ModelConfig) {
    this.client = new Anthropic({
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
    })
    this.maxOutputTokens = config.maxOutputTokens
    this.nativeAnthropic = isNativeAnthropicApi(config.baseUrl)
  }

  supportsDynamicToolSearch(model: string): boolean {
    return this.nativeAnthropic
      && !isExperimentalToolSearchBetaDisabled()
      && modelSupportsToolReference(model)
  }

  async createMessage(request: ModelRequest): Promise<ModelResponse> {
    return withRetry(
      async (attempt) => {
        const effectiveRequest: ModelRequest = {
          ...request,
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

        // Pass beta headers (for example, advanced tool use) to the API so
        // tool_reference blocks are expanded server-side.
        const betas = this.nativeAnthropic
          ? getAnthropicBetaHeaders(effectiveRequest, this.nativeAnthropic)
          : []

        const stream = this.client.messages.stream(
          payload as unknown as Anthropic.Messages.MessageStreamParams,
          betas.length > 0
            ? { headers: { 'anthropic-beta': betas.join(',') } as Record<string, string> }
            : undefined,
        )
        const response = await streamWithTimeout(
          stream,
          request.retry?.signal,
          STREAM_IDLE_TIMEOUT_MS,
          request.onTextDelta,
          request.onStreamEvent,
          STREAM_IDLE_WARNING_MS,
        )

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
  onTextDelta?: (delta: string) => void,
  onStreamEvent?: (event: ModelStreamEvent) => void,
  idleWarningMs = STREAM_IDLE_WARNING_MS,
): Promise<Anthropic.Messages.Message> {
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined
  let warningTimer: ReturnType<typeof setTimeout> | undefined
  const resetTimer = () => {
    if (timeoutTimer !== undefined) clearTimeout(timeoutTimer)
    if (warningTimer !== undefined) clearTimeout(warningTimer)
    if (idleWarningMs > 0 && idleWarningMs < idleTimeoutMs) {
      warningTimer = setTimeout(() => {
        onStreamEvent?.({ type: 'idle_warning', idleMs: idleWarningMs })
      }, idleWarningMs)
    }
    timeoutTimer = setTimeout(() => {
      stream.abort()
      rejectTimeout(new Error('Stream idle timeout'))
    }, idleTimeoutMs)
  }
  let rejectTimeout: (error: Error) => void = () => {}
  const timeoutPromise = new Promise<never>((_, reject) => {
    rejectTimeout = reject
  })
  const blockTypes = new Map<number, string>()
  const handleStreamEvent = (event: unknown) => {
    resetTimer()
    for (const modelEvent of extractModelStreamEvents(event, blockTypes)) {
      if (modelEvent.type === 'text_delta') onTextDelta?.(modelEvent.text)
      onStreamEventCallback?.(modelEvent)
    }
  }
  const onStreamEventCallback = onStreamEvent
  stream.on('streamEvent', handleStreamEvent)
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
    if (timeoutTimer !== undefined) clearTimeout(timeoutTimer)
    if (warningTimer !== undefined) clearTimeout(warningTimer)
    stream.off('streamEvent', handleStreamEvent)
    if (signal && onAbort) signal.removeEventListener('abort', onAbort)
  }
}

function extractModelStreamEvents(
  event: unknown,
  blockTypes: Map<number, string>,
): ModelStreamEvent[] {
  if (!event || typeof event !== 'object') return []
  const events: ModelStreamEvent[] = []
  const typed = event as {
    type?: unknown
    index?: unknown
    content_block?: {
      type?: unknown
    }
    delta?: {
      type?: unknown
      text?: unknown
      thinking?: unknown
      signature?: unknown
      partial_json?: unknown
    }
  }
  const index = typeof typed.index === 'number' ? typed.index : undefined

  if (typed.type === 'message_start') {
    return [{ type: 'message_start' }]
  }
  if (typed.type === 'message_stop') {
    return [{ type: 'message_stop' }]
  }

  if (typed.type === 'content_block_start') {
    const blockType = typeof typed.content_block?.type === 'string'
      ? typed.content_block.type
      : undefined
    if (index !== undefined && blockType) blockTypes.set(index, blockType)
    if (blockType === 'thinking') {
      events.push({ type: 'thinking_start', index, redacted: false })
    } else if (blockType === 'redacted_thinking') {
      events.push({ type: 'thinking_start', index, redacted: true })
      events.push({ type: 'redacted_thinking', index })
    }
    return events
  }

  if (typed.type === 'content_block_delta') {
    if (typed.delta?.type === 'text_delta' && typeof typed.delta.text === 'string' && typed.delta.text.length > 0) {
      events.push({ type: 'text_delta', index, text: typed.delta.text })
    } else if (typed.delta?.type === 'thinking_delta' && typeof typed.delta.thinking === 'string' && typed.delta.thinking.length > 0) {
      events.push({ type: 'thinking_delta', index, thinking: typed.delta.thinking })
    } else if (typed.delta?.type === 'signature_delta' && typeof typed.delta.signature === 'string') {
      events.push({ type: 'thinking_signature', index, signature: typed.delta.signature })
    } else if (typed.delta?.type === 'input_json_delta' && typeof typed.delta.partial_json === 'string' && typed.delta.partial_json.length > 0) {
      events.push({ type: 'tool_input_delta', index, partialJson: typed.delta.partial_json })
    }
    return events
  }

  if (typed.type === 'content_block_stop') {
    const blockType = index === undefined ? undefined : blockTypes.get(index)
    if (index !== undefined) blockTypes.delete(index)
    if (blockType === 'thinking' || blockType === 'redacted_thinking') {
      events.push({ type: 'thinking_stop', index })
    }
    return events
  }

  return events
}
