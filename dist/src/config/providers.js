import { createHash } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { addCacheBreakpoints, addCacheControlToLastSystemBlock, getPromptCachingEnabled, splitSystemForCaching, } from '../harness/cacheControl.js';
import { withRetry, isRetryableError } from './retry.js';
const MAX_OUTPUT_TOKENS_DEFAULT = 32_000;
const MAX_OUTPUT_TOKENS_UPPER_LIMIT = 128_000;
function getMaxOutputTokens(configValue) {
    const envValue = process.env.MYAGENT_MAX_OUTPUT_TOKENS;
    if (envValue) {
        const parsed = parseInt(envValue, 10);
        if (Number.isFinite(parsed) && parsed > 0) {
            return Math.min(parsed, MAX_OUTPUT_TOKENS_UPPER_LIMIT);
        }
    }
    if (configValue !== undefined && Number.isFinite(configValue) && configValue > 0) {
        return Math.min(configValue, MAX_OUTPUT_TOKENS_UPPER_LIMIT);
    }
    return MAX_OUTPUT_TOKENS_DEFAULT;
}
function anthropicContent(content) {
    return [{ type: 'text', text: content }];
}
function anthropicSystem(request) {
    const blocks = request.systemBlocks && request.systemBlocks.length > 0
        ? request.systemBlocks
        : request.system
            ? [request.system]
            : [];
    return blocks.map((b) => ({ type: 'text', text: b }));
}
function anthropicSystemWithCache(request) {
    const { staticBlocks, dynamicBlocks } = splitSystemForCaching(request.systemBlocks ?? (request.system ? [request.system] : []));
    const enableCaching = getPromptCachingEnabled(request.model);
    const staticText = staticBlocks.join('\n\n');
    const blocks = [];
    if (staticText) {
        blocks.push({ type: 'text', text: staticText });
    }
    for (const b of dynamicBlocks) {
        blocks.push({ type: 'text', text: b });
    }
    return addCacheControlToLastSystemBlock(blocks.filter((b) => b.text.length > 0), enableCaching);
}
function shouldDebugProviderPayloads() {
    return process.env.MYAGENT_DEBUG_PROVIDER === '1';
}
function debugProviderPayload(label, payload) {
    if (!shouldDebugProviderPayloads())
        return;
    console.error(`[myagent][provider:${label}] payload\n${JSON.stringify(payload, null, 2)}`);
}
function previewContent(value) {
    if (Array.isArray(value)) {
        return value
            .map((item) => {
            if (typeof item === 'string')
                return `text:${item.slice(0, 80)}`;
            if (item && typeof item === 'object' && 'type' in item) {
                const typed = item;
                if (typed.type === 'tool_use')
                    return `tool_use:${String(typed.name ?? '')}`;
                if (typed.type === 'tool_result')
                    return `tool_result:${String(typed.tool_use_id ?? '')}`;
                if (typed.type === 'text')
                    return `text:${String(typed.text ?? '').slice(0, 80)}`;
                return String(typed.type);
            }
            return typeof item;
        })
            .join(', ');
    }
    if (typeof value === 'string')
        return value.slice(0, 120);
    return typeof value;
}
function debugProviderSummary(label, request, payload) {
    if (!shouldDebugProviderPayloads())
        return;
    const toolNames = (request.tools ?? []).map((tool) => tool.name);
    const contextKinds = (request.contextItems ?? []).map((item) => item.kind);
    const messagesPreview = request.messages.map((message) => `${message.role}:${message.content.slice(0, 60)}`);
    let payloadPreview;
    if (payload && typeof payload === 'object') {
        const candidate = payload;
        const payloadMessages = Array.isArray(candidate.messages) ? candidate.messages : [];
        payloadPreview = payloadMessages.map((message) => {
            const typed = message;
            return {
                role: typed.role,
                content: previewContent(typed.content),
            };
        });
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
        promptCacheKeyPresent: Boolean(payload?.prompt_cache_key),
        promptCacheRetention: payload?.prompt_cache_retention,
    }, null, 2)}`);
}
function debugProviderResponse(label, response) {
    if (!shouldDebugProviderPayloads())
        return;
    if (label === 'anthropic') {
        const typed = response;
        const textBlocks = typed.content.filter((item) => item.type === 'text');
        const toolBlocks = typed.content.filter((item) => item.type === 'tool_use');
        const usage = normalizeAnthropicUsage(typed.usage);
        console.error(`[myagent][provider:${label}] response summary ${JSON.stringify({
            id: typed.id,
            model: typed.model,
            stopReason: typed.stop_reason,
            contentTypes: typed.content.map((item) => item.type),
            textLength: textBlocks.reduce((sum, item) => sum + (item.type === 'text' ? item.text.length : 0), 0),
            toolCalls: toolBlocks.map((item) => item.type === 'tool_use' ? item.name : undefined).filter(Boolean),
            usage,
        }, null, 2)}`);
        return;
    }
    const typed = response;
    const message = typed.choices[0]?.message;
    const usage = normalizeOpenAIUsage(typed.usage);
    console.error(`[myagent][provider:${label}] response summary ${JSON.stringify({
        id: typed.id,
        model: typed.model,
        finishReason: typed.choices[0]?.finish_reason,
        textLength: typeof message?.content === 'string' ? message.content.length : 0,
        usage,
        toolCalls: message?.tool_calls?.map((call) => {
            const fn = call;
            return fn.function?.name;
        }) ?? [],
    }, null, 2)}`);
}
function tokenNumber(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
export function normalizeAnthropicUsage(usage) {
    const typed = usage && typeof usage === 'object' ? usage : {};
    return {
        inputTokens: tokenNumber(typed.input_tokens) + tokenNumber(typed.cache_creation_input_tokens),
        cacheReadInputTokens: tokenNumber(typed.cache_read_input_tokens),
        outputTokens: tokenNumber(typed.output_tokens),
    };
}
export function normalizeOpenAIUsage(usage) {
    const typed = usage && typeof usage === 'object' ? usage : {};
    const details = typed.prompt_tokens_details && typeof typed.prompt_tokens_details === 'object'
        ? typed.prompt_tokens_details
        : {};
    const cacheReadInputTokens = tokenNumber(details.cached_tokens);
    const promptTokens = tokenNumber(typed.prompt_tokens);
    return {
        inputTokens: Math.max(0, promptTokens - cacheReadInputTokens),
        cacheReadInputTokens,
        outputTokens: tokenNumber(typed.completion_tokens),
    };
}
export function buildAnthropicMessages(request) {
    const contextItems = request.contextItems ?? request.messages.map((message) => ({ kind: 'message', message }));
    const messages = [];
    let pendingToolResults = [];
    for (const item of contextItems) {
        if (item.kind === 'message') {
            if (pendingToolResults.length > 0) {
                messages.push({ role: 'user', content: pendingToolResults });
                pendingToolResults = [];
            }
            if (item.message.role !== 'user' && item.message.role !== 'assistant')
                continue;
            messages.push({
                role: item.message.role,
                content: anthropicContent(item.message.content),
            });
            continue;
        }
        if (item.kind === 'tool_use') {
            const lastMessage = messages[messages.length - 1];
            const toolUseBlock = {
                type: 'tool_use',
                id: item.id,
                name: item.tool,
                input: item.input,
            };
            if (lastMessage && lastMessage.role === 'assistant') {
                const existingContent = lastMessage.content;
                const contentArray = Array.isArray(existingContent)
                    ? existingContent
                    : typeof existingContent === 'string'
                        ? anthropicContent(existingContent)
                        : [existingContent];
                const filteredContent = contentArray.filter((block) => {
                    if (typeof block === 'string') {
                        return block.trim() !== '';
                    }
                    return true;
                });
                lastMessage.content = [...filteredContent, toolUseBlock];
            }
            else {
                messages.push({
                    role: 'assistant',
                    content: [toolUseBlock],
                });
            }
            continue;
        }
        pendingToolResults.push({
            type: 'tool_result',
            tool_use_id: item.toolUseId,
            content: item.content,
            is_error: !item.ok,
        });
    }
    if (pendingToolResults.length > 0) {
        messages.push({ role: 'user', content: pendingToolResults });
    }
    return messages;
}
export function buildOpenAIMessages(request) {
    const contextItems = request.contextItems ?? request.messages.map((message) => ({ kind: 'message', message }));
    const messages = [
        ...(request.system ? [{ role: 'system', content: request.system }] : []),
    ];
    for (const item of contextItems) {
        if (item.kind === 'message') {
            if (item.message.role !== 'user' && item.message.role !== 'assistant')
                continue;
            messages.push({
                role: item.message.role,
                content: item.message.content,
            });
            continue;
        }
        if (item.kind === 'tool_use') {
            const lastMessage = messages[messages.length - 1];
            const toolCall = {
                id: item.id,
                type: 'function',
                function: {
                    name: item.tool,
                    arguments: JSON.stringify(item.input ?? {}),
                },
            };
            if (lastMessage && lastMessage.role === 'assistant') {
                const existing = lastMessage.tool_calls ?? [];
                lastMessage.tool_calls = [...existing, toolCall];
                if (typeof lastMessage.content === 'string' && lastMessage.content.trim() === '') {
                    lastMessage.content = '';
                }
            }
            else {
                messages.push({
                    role: 'assistant',
                    content: '',
                    tool_calls: [toolCall],
                });
            }
            continue;
        }
        messages.push({
            role: 'tool',
            content: item.content,
            tool_call_id: item.toolUseId,
        });
    }
    return messages;
}
export function buildAnthropicTools(tools = []) {
    return tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema,
    }));
}
export function buildOpenAITools(tools = []) {
    return tools.map((tool) => ({
        type: 'function',
        function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema,
        },
    }));
}
export function buildOpenAIPromptCacheKey(request) {
    const tools = buildOpenAITools(request.tools).map((tool) => ({
        name: tool.function.name,
        description: tool.function.description,
        parameters: tool.function.parameters,
    }));
    const hash = createHash('sha256')
        .update(JSON.stringify({
        model: request.model,
        system: request.system ?? '',
        tools,
    }))
        .digest('hex')
        .slice(0, 32);
    return `myagent:${hash}`;
}
export function buildAnthropicPayload(request, maxOutputTokens) {
    const tools = buildAnthropicTools(request.tools);
    const enableCaching = getPromptCachingEnabled(request.model);
    const messages = buildAnthropicMessages(request);
    return {
        model: request.model,
        max_tokens: getMaxOutputTokens(maxOutputTokens ?? request.maxOutputTokens),
        messages: addCacheBreakpoints(messages, enableCaching),
        ...(request.system || request.systemBlocks?.length
            ? { system: anthropicSystemWithCache(request) }
            : {}),
        ...(tools.length > 0
            ? {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                tools: tools,
                tool_choice: { type: 'auto', disable_parallel_tool_use: true },
            }
            : {}),
    };
}
export function buildOpenAIPayload(request) {
    const tools = buildOpenAITools(request.tools);
    return {
        model: request.model,
        messages: buildOpenAIMessages(request),
        prompt_cache_key: buildOpenAIPromptCacheKey(request),
        ...(request.promptCacheRetention ? { prompt_cache_retention: request.promptCacheRetention } : {}),
        ...(tools.length > 0
            ? {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                tools: tools,
            }
            : {}),
    };
}
const STREAM_IDLE_TIMEOUT_MS = parseInt(process.env.MYAGENT_STREAM_IDLE_TIMEOUT_MS || '', 10) || 90_000;
export class AnthropicProvider {
    name = 'anthropic';
    client;
    maxOutputTokens;
    constructor(config) {
        this.client = new Anthropic({
            apiKey: config.apiKey,
            baseURL: config.baseUrl,
        });
        this.maxOutputTokens = config.maxOutputTokens;
    }
    async createMessage(request) {
        return withRetry(async (attempt) => {
            const payload = buildAnthropicPayload(request, this.maxOutputTokens);
            if (attempt > 1) {
                debugProviderPayload('anthropic-retry', payload);
            }
            debugProviderSummary('anthropic', request, payload);
            debugProviderPayload('anthropic', payload);
            let response;
            try {
                const stream = this.client.messages.stream(payload);
                response = await streamWithTimeout(stream);
            }
            catch (streamError) {
                if (isStreamTimeoutError(streamError)) {
                    return await this.executeNonStreamingRequest(payload, request);
                }
                throw streamError;
            }
            debugProviderResponse('anthropic', response);
            return this.parseResponse(response);
        }, {
            maxRetries: request.retry?.maxRetries ?? 3,
            shouldRetry: (error) => isRetryableError(error),
            signal: request.retry?.signal,
        });
    }
    parseResponse(response) {
        const content = response.content.find((c) => c.type === 'text');
        const toolUses = response.content.filter((c) => c.type === 'tool_use');
        let textContent = content?.type === 'text' ? content.text : '';
        if (toolUses.length > 0 && textContent.trim() === '') {
            textContent = '';
        }
        return {
            content: textContent,
            toolCalls: toolUses.map((c) => {
                if (c.type !== 'tool_use')
                    throw new Error('Unexpected content type');
                return {
                    id: c.id,
                    name: c.name,
                    input: c.input,
                };
            }),
            usage: normalizeAnthropicUsage(response.usage),
            requestId: response.id,
            stopReason: response.stop_reason ?? undefined,
        };
    }
    async executeNonStreamingRequest(payload, request) {
        const nonStreamingPayload = {
            ...payload,
            stream: false,
            max_tokens: Math.min(payload.max_tokens ?? 32_000, 64_000),
        };
        debugProviderPayload('anthropic-nonstreaming', nonStreamingPayload);
        const response = await this.client.messages.create(nonStreamingPayload);
        debugProviderResponse('anthropic', response);
        return this.parseResponse(response);
    }
}
function isStreamTimeoutError(error) {
    return error instanceof Error && error.message.includes('Stream idle timeout');
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function streamWithTimeout(stream) {
    return Promise.race([
        stream.finalMessage(),
        new Promise((_, reject) => {
            setTimeout(() => reject(new Error('Stream idle timeout')), STREAM_IDLE_TIMEOUT_MS);
        }),
    ]);
}
export class OpenAIProvider {
    name = 'openai';
    client;
    constructor(config) {
        this.client = new OpenAI({
            apiKey: config.apiKey,
            baseURL: config.baseUrl,
        });
    }
    async createMessage(request) {
        const payload = buildOpenAIPayload(request);
        debugProviderSummary('openai', request, payload);
        debugProviderPayload('openai', payload);
        const response = await this.client.chat.completions.create(payload, {
            signal: request.retry?.signal,
        });
        debugProviderResponse('openai', response);
        const choice = response.choices[0];
        const message = choice?.message;
        const toolCalls = message?.tool_calls?.map((tc) => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const fn = tc;
            return {
                id: tc.id,
                name: fn.function.name,
                input: typeof fn.function.arguments === 'string'
                    ? JSON.parse(fn.function.arguments)
                    : fn.function.arguments,
            };
        }) ?? [];
        let content = message?.content ?? '';
        if (toolCalls.length > 0 && typeof content === 'string' && content.trim() === '') {
            content = '';
        }
        return {
            content,
            toolCalls,
            usage: normalizeOpenAIUsage(response.usage),
            requestId: response.id,
            stopReason: choice?.finish_reason ?? undefined,
        };
    }
}
export class ProviderRegistry {
    providers = new Map();
    register(provider) {
        this.providers.set(provider.name, provider);
    }
    get(name) {
        return this.providers.get(name);
    }
    has(name) {
        return this.providers.has(name);
    }
    list() {
        return Array.from(this.providers.keys());
    }
}
export function createProvider(config) {
    switch (config.provider) {
        case 'anthropic':
            return new AnthropicProvider(config);
        case 'openai':
            return new OpenAIProvider(config);
        default:
            return undefined;
    }
}
