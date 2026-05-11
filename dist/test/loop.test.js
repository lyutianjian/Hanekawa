import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentLoop } from '../src/harness/loop.js';
import { ContextBuilder } from '../src/harness/contextBuilder.js';
import { PermissionGate } from '../src/harness/permissions.js';
import { ToolRunner } from '../src/harness/toolRunner.js';
test('agent loop appends user and assistant messages', async () => {
    const records = [];
    const provider = {
        name: 'fake',
        async createMessage(request) {
            assert.ok(!('maxTokens' in request));
            return {
                content: 'hello back',
                toolCalls: [],
                usage: {
                    cacheReadInputTokens: 10,
                    inputTokens: 20,
                    outputTokens: 30,
                },
            };
        },
    };
    const tools = [];
    const runner = new ToolRunner(tools, new PermissionGate(async () => true), {
        onRecord: async (record) => { records.push(record); },
    });
    const loop = new AgentLoop({
        provider,
        model: 'fake-model',
        tools,
        contextBuilder: new ContextBuilder(),
        toolRunner: runner,
        toolContext: { cwd: process.cwd(), sessionId: 's1', readFiles: new Set() },
        loadRecords: async () => records,
        appendRecord: async (record) => { records.push(record); },
    });
    const response = await loop.run('hello');
    assert.equal(response.content, 'hello back');
    assert.deepEqual(response.usage, {
        cacheReadInputTokens: 10,
        inputTokens: 20,
        outputTokens: 30,
    });
    assert.equal(records.filter((record) => record.type === 'message').length, 2);
});
test('agent loop sends tool result into the next model request', async () => {
    const records = [];
    const seenRequests = [];
    let callCount = 0;
    const provider = {
        name: 'fake',
        async createMessage(request) {
            seenRequests.push(request);
            callCount += 1;
            if (callCount === 1) {
                return {
                    content: 'I will use the echo tool.',
                    toolCalls: [{ id: 'call-1', name: 'echo', input: { value: 'hello' } }],
                    usage: {
                        cacheReadInputTokens: 1,
                        inputTokens: 2,
                        outputTokens: 3,
                    },
                };
            }
            const contextItems = request.contextItems ?? [];
            assert.ok(contextItems.some((item) => item.kind === 'message' && item.message.role === 'assistant' && item.message.content === 'I will use the echo tool.'));
            assert.ok(contextItems.some((item) => item.kind === 'tool_use' && item.id === 'call-1'));
            assert.ok(contextItems.some((item) => item.kind === 'tool_result' && item.toolUseId === 'call-1' && item.content === '{"value":"hello"}'));
            return {
                content: 'done',
                toolCalls: [],
                usage: {
                    cacheReadInputTokens: 4,
                    inputTokens: 5,
                    outputTokens: 6,
                },
            };
        },
    };
    const tools = [{
            name: 'echo',
            description: 'echo',
            inputSchema: {},
            riskLevel: 'safe',
            execute: async (input) => ({ ok: true, content: JSON.stringify(input) }),
        }];
    const runner = new ToolRunner(tools, new PermissionGate(async () => true), {
        onRecord: async (record) => { records.push(record); },
    });
    const loop = new AgentLoop({
        provider,
        model: 'fake-model',
        tools,
        contextBuilder: new ContextBuilder(),
        toolRunner: runner,
        toolContext: { cwd: process.cwd(), sessionId: 's1', readFiles: new Set() },
        loadRecords: async () => records,
        appendRecord: async (record) => { records.push(record); },
    });
    const response = await loop.run('hello');
    assert.equal(response.content, 'done');
    assert.deepEqual(response.usage, {
        cacheReadInputTokens: 5,
        inputTokens: 7,
        outputTokens: 9,
    });
    assert.equal(seenRequests.length, 2);
    assert.ok(records.some((record) => record.type === 'message' && record.role === 'assistant' && record.content === 'I will use the echo tool.'));
    assert.ok(records.some((record) => record.type === 'tool_use'));
    assert.ok(records.some((record) => record.type === 'tool_result'));
    assert.equal(records.filter((record) => record.type === 'message' && record.role === 'tool').length, 0);
});
test('agent loop auto-compacts before model request when context is near limit', async () => {
    const records = [
        {
            type: 'message',
            id: 'old-user',
            role: 'user',
            content: 'old context '.repeat(200),
            createdAt: '2026-05-10T00:00:00.000Z',
        },
        {
            type: 'message',
            id: 'old-assistant',
            role: 'assistant',
            content: 'old answer '.repeat(200),
            createdAt: '2026-05-10T00:01:00.000Z',
        },
    ];
    let callCount = 0;
    const provider = {
        name: 'fake',
        async createMessage(request) {
            callCount += 1;
            if (callCount === 1) {
                assert.equal(request.tools?.length, 0);
                return {
                    content: 'summary',
                    toolCalls: [],
                    usage: {
                        cacheReadInputTokens: 10,
                        inputTokens: 20,
                        outputTokens: 30,
                    },
                };
            }
            const contextItems = request.contextItems ?? [];
            assert.ok(contextItems.some((item) => item.kind === 'message' && item.message.id.startsWith('meta:user-context')));
            assert.ok(contextItems.some((item) => item.kind === 'message' && /Prior conversation was compacted/.test(item.message.content)));
            assert.ok(!contextItems.some((item) => item.kind === 'message' && item.message.id === 'old-user'));
            return {
                content: 'done',
                toolCalls: [],
                usage: {
                    cacheReadInputTokens: 1,
                    inputTokens: 2,
                    outputTokens: 3,
                },
            };
        },
    };
    const tools = [];
    const runner = new ToolRunner(tools, new PermissionGate(async () => true), {
        onRecord: async (record) => { records.push(record); },
    });
    const loop = new AgentLoop({
        provider,
        model: 'fake-model',
        tools,
        contextBuilder: new ContextBuilder(),
        toolRunner: runner,
        toolContext: { cwd: process.cwd(), sessionId: 's1', readFiles: new Set() },
        contextManagement: {
            contextWindow: 600,
            summaryOutputTokens: 100,
            autoCompactBufferTokens: 50,
        },
        loadRecords: async () => records,
        appendRecord: async (record) => { records.push(record); },
    });
    const response = await loop.run('latest request');
    assert.equal(response.content, 'done');
    assert.deepEqual(response.usage, {
        cacheReadInputTokens: 11,
        inputTokens: 22,
        outputTokens: 33,
    });
    assert.equal(callCount, 2);
    assert.ok(records.some((record) => record.type === 'compact_boundary'));
});
