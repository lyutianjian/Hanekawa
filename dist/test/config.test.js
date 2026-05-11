import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { ConfigService } from '../src/config/service.js';
import { AnthropicProvider, OpenAIProvider, ProviderRegistry, buildAnthropicMessages, buildAnthropicPayload, buildAnthropicTools, buildOpenAIMessages, buildOpenAIPayload, buildOpenAIPromptCacheKey, buildOpenAITools, createProvider, normalizeAnthropicUsage, normalizeOpenAIUsage, } from '../src/config/providers.js';
import { getAllTools, getBuiltinTools } from '../src/tools/index.js';
import { ContextBuilder } from '../src/harness/contextBuilder.js';
test('ConfigService loads defaults and saves config', async () => {
    const dir = await mkdtemp(path.join(process.env.TEMP ?? '/tmp', 'myagent-config-'));
    try {
        const service = new ConfigService(dir);
        await service.load();
        const config = service.get();
        assert.ok(config.models);
        assert.ok(config.agent);
        assert.equal(config.defaultModel, 'anthropic');
        service.addModel('test', { provider: 'anthropic', model: 'test-model' });
        assert.ok(service.getModel('test'));
        assert.equal(service.getModel('test')?.model, 'test-model');
        service.setDefaultModel('test');
        assert.equal(service.getDefaultModel()?.model, 'test-model');
    }
    finally {
        await rm(dir, { recursive: true, force: true });
    }
});
test('ConfigService accepts model pricing config', async () => {
    const dir = await mkdtemp(path.join(process.env.TEMP ?? '/tmp', 'myagent-config-'));
    try {
        const service = new ConfigService(dir);
        await service.load();
        service.addModel('priced', {
            provider: 'openai',
            model: 'gpt-test',
            pricing: {
                cacheReadInputPerMillionTokens: 0.1,
                inputPerMillionTokens: 1,
                outputPerMillionTokens: 2,
                currency: 'USD',
            },
        });
        assert.deepEqual(service.getModel('priced')?.pricing, {
            cacheReadInputPerMillionTokens: 0.1,
            inputPerMillionTokens: 1,
            outputPerMillionTokens: 2,
            currency: 'USD',
        });
    }
    finally {
        await rm(dir, { recursive: true, force: true });
    }
});
test('ProviderRegistry registers and retrieves providers', () => {
    const registry = new ProviderRegistry();
    assert.ok(!registry.has('test'));
    assert.equal(registry.get('test'), undefined);
    const provider = createProvider({ provider: 'anthropic', model: 'claude-3' });
    if (provider) {
        registry.register(provider);
        assert.ok(registry.has('anthropic'));
        assert.equal(registry.get('anthropic')?.name, 'anthropic');
        assert.deepEqual(registry.list(), ['anthropic']);
    }
});
test('createProvider selects adapter from provider field', () => {
    const anthropic = createProvider({ provider: 'anthropic', model: 'claude-3', apiKey: 'test-key' });
    const openai = createProvider({ provider: 'openai', model: 'gpt-4o-mini', apiKey: 'test-key' });
    assert.ok(anthropic instanceof AnthropicProvider);
    assert.ok(openai instanceof OpenAIProvider);
});
test('buildAnthropicMessages includes tool use and tool results', () => {
    const request = {
        model: 'fake-model',
        system: 'system text',
        messages: [],
        contextItems: [
            {
                kind: 'message',
                message: {
                    id: 'u1',
                    role: 'user',
                    content: 'hello',
                    createdAt: new Date().toISOString(),
                },
            },
            {
                kind: 'tool_use',
                id: 'call-1',
                tool: 'readFile',
                input: { filePath: 'a.txt' },
            },
            {
                kind: 'tool_result',
                toolUseId: 'call-1',
                tool: 'readFile',
                ok: true,
                content: 'file body',
            },
        ],
    };
    const messages = buildAnthropicMessages(request);
    assert.equal(messages.length, 3);
    assert.equal(messages[0]?.role, 'user');
    assert.deepEqual(messages[0]?.content, [{
            type: 'text',
            text: 'hello',
            cache_control: { type: 'ephemeral' },
        }]);
    assert.equal(messages[1]?.role, 'assistant');
    assert.deepEqual(messages[1]?.content, [{
            type: 'tool_use',
            id: 'call-1',
            name: 'readFile',
            input: { filePath: 'a.txt' },
        }]);
    assert.equal(messages[2]?.role, 'user');
    assert.deepEqual(messages[2]?.content, [{
            type: 'tool_result',
            tool_use_id: 'call-1',
            content: 'file body',
            is_error: false,
        }]);
});
test('buildAnthropicPayload caches system and message text blocks', () => {
    const request = {
        model: 'fake-model',
        system: 'system text',
        systemBlocks: ['identity text', 'instruction text', 'custom system text'],
        messages: [{
                id: 'u1',
                role: 'user',
                content: 'hello',
                createdAt: new Date().toISOString(),
            }],
    };
    const payload = buildAnthropicPayload(request);
    assert.deepEqual(payload.system, [
        {
            type: 'text',
            text: 'identity text',
            cache_control: { type: 'ephemeral' },
        },
        {
            type: 'text',
            text: 'instruction text',
            cache_control: { type: 'ephemeral' },
        },
        {
            type: 'text',
            text: 'custom system text',
            cache_control: { type: 'ephemeral' },
        },
    ]);
    assert.deepEqual(payload.messages, [{
            role: 'user',
            content: [{
                    type: 'text',
                    text: 'hello',
                    cache_control: { type: 'ephemeral' },
                }],
        }]);
});
test('normalizeAnthropicUsage maps cache and output tokens', () => {
    assert.deepEqual(normalizeAnthropicUsage({
        input_tokens: 100,
        cache_creation_input_tokens: 20,
        cache_read_input_tokens: 300,
        output_tokens: 40,
    }), {
        cacheReadInputTokens: 300,
        inputTokens: 120,
        outputTokens: 40,
    });
});
test('normalizeOpenAIUsage splits cached and uncached prompt tokens', () => {
    assert.deepEqual(normalizeOpenAIUsage({
        prompt_tokens: 500,
        completion_tokens: 60,
        prompt_tokens_details: {
            cached_tokens: 200,
        },
    }), {
        cacheReadInputTokens: 200,
        inputTokens: 300,
        outputTokens: 60,
    });
});
test('buildOpenAIMessages includes tool call history and tool results', () => {
    const request = {
        model: 'fake-model',
        messages: [],
        contextItems: [
            {
                kind: 'message',
                message: {
                    id: 'u1',
                    role: 'user',
                    content: 'hello',
                    createdAt: new Date().toISOString(),
                },
            },
            {
                kind: 'tool_use',
                id: 'call-1',
                tool: 'grep',
                input: { pattern: 'hello' },
            },
            {
                kind: 'tool_result',
                toolUseId: 'call-1',
                tool: 'grep',
                ok: true,
                content: 'a.txt:1: hello',
            },
        ],
    };
    const messages = buildOpenAIMessages(request);
    assert.equal(messages.length, 3);
    assert.equal(messages[0]?.role, 'user');
    assert.equal(messages[1]?.role, 'assistant');
    assert.deepEqual(messages[1].tool_calls, [{
            id: 'call-1',
            type: 'function',
            function: {
                name: 'grep',
                arguments: JSON.stringify({ pattern: 'hello' }),
            },
        }]);
    assert.equal(messages[2]?.role, 'tool');
    assert.equal(messages[2].tool_call_id, 'call-1');
});
test('buildAnthropicPayload omits tool fields for plain-text requests', () => {
    const request = {
        model: 'fake-model',
        messages: [{
                id: 'u1',
                role: 'user',
                content: 'hello',
                createdAt: new Date().toISOString(),
            }],
    };
    const payload = buildAnthropicPayload(request);
    assert.equal(payload.model, 'fake-model');
    assert.ok(Array.isArray(payload.messages));
    assert.ok(!('tools' in payload));
    assert.ok(!('tool_choice' in payload));
    assert.ok(!('system' in payload));
});
test('buildOpenAIPayload omits tools for plain-text requests', () => {
    const request = {
        model: 'fake-model',
        messages: [{
                id: 'u1',
                role: 'user',
                content: 'hello',
                createdAt: new Date().toISOString(),
            }],
    };
    const payload = buildOpenAIPayload(request);
    assert.equal(payload.model, 'fake-model');
    assert.ok(Array.isArray(payload.messages));
    assert.ok(!('tools' in payload));
    assert.equal(JSON.stringify(payload).includes('cache_control'), false);
    assert.equal(typeof payload.prompt_cache_key, 'string');
});
test('buildOpenAIPayload includes Hanekawa system, skills reminder, Skill tool, and cache key', async () => {
    const tools = await getAllTools(process.cwd());
    const builder = new ContextBuilder(undefined, { contextWindow: 5000, summaryOutputTokens: 0 });
    const built = builder.build({
        records: [{
                type: 'message',
                id: 'u1',
                role: 'user',
                content: 'hello',
                createdAt: new Date().toISOString(),
            }],
        tools,
        skills: [
            { name: 'debugging', description: 'Use when diagnosing bugs', content: 'Debug content' },
        ],
        system: 'custom system',
        now: new Date('2026-05-10T12:00:00.000Z'),
    });
    const request = {
        model: 'gpt-test',
        system: built.system,
        messages: built.messages,
        contextItems: built.contextItems,
        tools,
        promptCacheRetention: '24h',
    };
    const payload = buildOpenAIPayload(request);
    assert.equal(payload.messages[0]?.role, 'system');
    assert.match(payload.messages[0]?.content ?? '', /You are Hanekawa/);
    assert.match(payload.messages[0]?.content ?? '', /lyutianjian/);
    assert.match(payload.messages[0]?.content ?? '', /# Doing tasks/);
    assert.match(payload.messages[0]?.content ?? '', /# Using your tools/);
    assert.match(payload.messages[0]?.content ?? '', /custom system/);
    assert.ok(payload.messages.some((message) => message.role === 'user' && /The following skills are available for use with the Skill tool/.test(message.content)));
    assert.ok(payload.messages.some((message) => /- debugging: Use when diagnosing bugs/.test(message.content)));
    assert.ok(payload.tools.some((tool) => tool.function.name === 'Skill'));
    assert.equal(payload.tools.some((tool) => tool.function.name.startsWith('skill_')), false);
    assert.match(payload.prompt_cache_key, /^myagent:[a-f0-9]{32}$/);
    assert.equal(payload.prompt_cache_retention, '24h');
    assert.equal(JSON.stringify(payload).includes('cache_control'), false);
});
test('buildOpenAIPromptCacheKey is stable for model, system, and tools', async () => {
    const tools = await getAllTools(process.cwd());
    const request = {
        model: 'gpt-test',
        system: 'system text',
        messages: [],
        tools,
    };
    assert.equal(buildOpenAIPromptCacheKey(request), buildOpenAIPromptCacheKey({ ...request, messages: [] }));
    assert.notEqual(buildOpenAIPromptCacheKey(request), buildOpenAIPromptCacheKey({ ...request, system: 'different system' }));
});
test('buildOpenAITools includes concrete schemas for built-in tools', () => {
    const readFileTool = getBuiltinTools().find((tool) => tool.name === 'readFile');
    assert.ok(readFileTool);
    const tools = buildOpenAITools([readFileTool]);
    assert.equal(tools.length, 1);
    assert.deepEqual(tools[0]?.function.parameters, {
        type: 'object',
        properties: {
            filePath: { type: 'string' },
        },
        required: ['filePath'],
        additionalProperties: false,
    });
});
test('buildAnthropicTools includes concrete schemas for built-in tools', () => {
    const readFileTool = getBuiltinTools().find((tool) => tool.name === 'readFile');
    assert.ok(readFileTool);
    const tools = buildAnthropicTools([readFileTool]);
    assert.equal(tools.length, 1);
    assert.deepEqual(tools[0]?.input_schema, {
        type: 'object',
        properties: {
            filePath: { type: 'string' },
        },
        required: ['filePath'],
        additionalProperties: false,
    });
});
test('buildAnthropicMessages merges assistant text with following tool use', () => {
    const request = {
        model: 'fake-model',
        messages: [],
        contextItems: [
            {
                kind: 'message',
                message: {
                    id: 'u1',
                    role: 'user',
                    content: 'read the file',
                    createdAt: new Date().toISOString(),
                },
            },
            {
                kind: 'message',
                message: {
                    id: 'a1',
                    role: 'assistant',
                    content: 'I will read it now.',
                    createdAt: new Date().toISOString(),
                },
            },
            {
                kind: 'tool_use',
                id: 'call-1',
                tool: 'readFile',
                input: { filePath: 'src/config/providers.ts' },
            },
        ],
    };
    const messages = buildAnthropicMessages(request);
    assert.equal(messages.length, 2);
    assert.equal(messages[1]?.role, 'assistant');
    assert.deepEqual(messages[1]?.content, [
        {
            type: 'text',
            text: 'I will read it now.',
            cache_control: { type: 'ephemeral' },
        },
        {
            type: 'tool_use',
            id: 'call-1',
            name: 'readFile',
            input: { filePath: 'src/config/providers.ts' },
        },
    ]);
});
test('buildOpenAIMessages merges assistant text with following tool call', () => {
    const request = {
        model: 'fake-model',
        messages: [],
        contextItems: [
            {
                kind: 'message',
                message: {
                    id: 'u1',
                    role: 'user',
                    content: 'search for hello',
                    createdAt: new Date().toISOString(),
                },
            },
            {
                kind: 'message',
                message: {
                    id: 'a1',
                    role: 'assistant',
                    content: 'I will search the codebase.',
                    createdAt: new Date().toISOString(),
                },
            },
            {
                kind: 'tool_use',
                id: 'call-1',
                tool: 'grep',
                input: { pattern: 'hello' },
            },
        ],
    };
    const messages = buildOpenAIMessages(request);
    assert.equal(messages.length, 2);
    assert.equal(messages[1]?.role, 'assistant');
    assert.equal(messages[1].content, 'I will search the codebase.');
    assert.deepEqual(messages[1].tool_calls, [{
            id: 'call-1',
            type: 'function',
            function: {
                name: 'grep',
                arguments: JSON.stringify({ pattern: 'hello' }),
            },
        }]);
});
