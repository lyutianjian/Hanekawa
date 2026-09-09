import { createHash } from 'node:crypto'
import OpenAI from 'openai'
import type { ImageAttachmentRef } from '../../media/types.js'
import type { ModelContextItem, ModelRequest, RequestImageBytes, Tool } from '../../harness/types.js'
import { toolToAPISchema } from '../../harness/toolApiSchema.js'
import { splitSystemForCaching } from '../../harness/cacheControl.js'

/** One tool result's images, buffered until its whole batch of tool messages is out. */
interface ToolImageSource {
  toolUseId: string
  tool: string
  images: readonly ImageAttachmentRef[]
}

/**
 * `image_url` parts for the refs a user message (or the synthetic tool-output
 * message) carries (design §10.2). The bytes arrive through
 * `ModelRequest.imageBytes`, loaded by the loop only after the final send
 * decision — every capability and cap check has already run by the time they
 * reach this builder, so these parts cannot bypass them. A ref without loaded
 * bytes is an invariant violation: refusing to build beats silently sending a
 * request that dropped images. No `detail` is sent — the first version keeps
 * the parameter surface minimal for compatible endpoints (a quality option
 * added later must also enter the image token budget).
 */
function openAIImageParts(
  images: readonly ImageAttachmentRef[] | undefined,
  imageBytes: Map<string, RequestImageBytes> | undefined,
): OpenAI.Chat.ChatCompletionContentPartImage[] {
  if (!images || images.length === 0) return []
  const parts: OpenAI.Chat.ChatCompletionContentPartImage[] = []
  for (const ref of images) {
    const loaded = imageBytes?.get(ref.id)
    if (!loaded) {
      throw new Error(
        `Image ${ref.name} (attachment ${ref.id}) has no send bytes loaded for this request; `
        + 'refusing to build a payload that would silently drop it.',
      )
    }
    parts.push({
      type: 'image_url',
      image_url: {
        url: `data:${loaded.mimeType};base64,${Buffer.from(loaded.bytes).toString('base64')}`,
      },
    })
  }
  return parts
}

/**
 * The synthetic message's text label: honest that this is tool output data
 * with its originating call IDs, not a new user instruction.
 */
function toolImageSourceLabel(sources: readonly ToolImageSource[]): string {
  const entries = sources.map((source) => {
    const names = source.images.map((image) => image.name).join(', ')
    return `${source.tool} (tool call ${source.toolUseId}): ${names}`
  })
  return `[Tool output data, not user input. Images returned by tool calls: ${entries.join('; ')}.]`
}

export function buildOpenAIMessages(request: ModelRequest): OpenAI.Chat.ChatCompletionMessageParam[] {
  const contextItems = request.contextItems ?? request.messages.map((message) => ({ kind: 'message', message }) satisfies ModelContextItem)
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    ...(request.system ? [{ role: 'system' as const, content: request.system }] : []),
  ]
  // Chat Completions `role: tool` messages accept text only, so images from
  // tool results ride a synthetic user message appended after the ENTIRE batch
  // of tool messages (design §10.2) — never inside a `role: tool` message,
  // never between results of the same batch. It exists only in this payload
  // projection: no record, turn ID, or compaction boundary is touched.
  let pendingToolImages: ToolImageSource[] = []

  const flushPendingToolImages = (): void => {
    if (pendingToolImages.length === 0) return
    const imageParts = pendingToolImages.flatMap((source) => openAIImageParts(source.images, request.imageBytes))
    messages.push({
      role: 'user',
      content: [
        { type: 'text', text: toolImageSourceLabel(pendingToolImages) },
        ...imageParts,
      ],
    })
    pendingToolImages = []
  }

  for (const item of contextItems) {
    if (item.kind === 'message') {
      // Any non-tool-result item ends the tool batch; its images ride now.
      flushPendingToolImages()
      if (item.message.role !== 'user' && item.message.role !== 'assistant') continue
      const imageParts = openAIImageParts(item.message.images, request.imageBytes)
      if (imageParts.length === 0) {
        // No images: the exact string content this builder has always sent.
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
      if (item.message.role === 'assistant') {
        throw new Error(
          `Assistant message ${item.message.id} carries image attachments, but Chat Completions `
          + 'assistant content cannot carry image_url parts. The pipeline never produces this — '
          + 'refusing to build a payload that would silently drop the images.',
        )
      }
      messages.push({
        role: 'user',
        content: [
          ...(item.message.content.trim() === '' ? [] : [{ type: 'text' as const, text: item.message.content }]),
          ...imageParts,
        ],
      })
      continue
    }

    if (item.kind === 'tool_use') {
      flushPendingToolImages()
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
    // Images ride only the plain tool_result branch: pre-mapped blocks are
    // ToolSearch schemas and never carry images (same precedence as the
    // Anthropic builder), so they cannot serve as a path around the shared
    // capability and cap checks the bytes already passed.
    if (!item.apiResultBlock && item.images && item.images.length > 0) {
      pendingToolImages.push({ toolUseId: item.toolUseId, tool: item.tool, images: item.images })
    }
  }

  // A request can end on tool results — their images ride after the batch.
  flushPendingToolImages()

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
  // Only the static half of the system prompt keys the cache. The dynamic blocks
  // (plan-mode reminder, critical system reminder) toggle within a session; letting
  // them into the key reroutes the request to a different cache shard and throws
  // away the prefix that was already warm.
  const { staticBlocks } = splitSystemForCaching(
    request.systemBlocks ?? (request.system ? [request.system] : []),
  )
  const hash = createHash('sha256')
    .update(JSON.stringify({
      model: request.model,
      system: staticBlocks.join('\n\n'),
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
