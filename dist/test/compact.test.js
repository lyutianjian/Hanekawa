import test from 'node:test';
import assert from 'node:assert/strict';
import { autoCompactIfNeeded } from '../src/harness/compact.js';
test('autoCompactIfNeeded writes compact boundary when threshold is exceeded', async () => {
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
        {
            type: 'message',
            id: 'latest-user',
            role: 'user',
            content: 'latest request',
            createdAt: '2026-05-10T00:02:00.000Z',
        },
    ];
    const appended = [];
    const provider = {
        name: 'fake',
        async createMessage(request) {
            assert.equal(request.tools?.length, 0);
            assert.match(request.messages[0]?.content ?? '', /old context/);
            assert.doesNotMatch(request.messages[0]?.content ?? '', /latest request/);
            return {
                content: 'compact summary',
                toolCalls: [],
                usage: {
                    cacheReadInputTokens: 1,
                    inputTokens: 2,
                    outputTokens: 3,
                },
            };
        },
    };
    const result = await autoCompactIfNeeded({
        records,
        provider,
        model: 'fake-model',
        tools: [],
        contextManagement: {
            contextWindow: 600,
            summaryOutputTokens: 100,
            autoCompactBufferTokens: 50,
        },
        appendRecord: async (record) => { appended.push(record); },
    });
    assert.equal(result.compacted, true);
    assert.deepEqual(result.usage, {
        cacheReadInputTokens: 1,
        inputTokens: 2,
        outputTokens: 3,
    });
    assert.equal(appended.length, 1);
    assert.equal(appended[0]?.type, 'compact_boundary');
    assert.equal(appended[0]?.type === 'compact_boundary' ? appended[0].summary : '', 'compact summary');
});
test('autoCompactIfNeeded skips compacting below threshold', async () => {
    const records = [{
            type: 'message',
            id: 'user',
            role: 'user',
            content: 'short',
            createdAt: '2026-05-10T00:00:00.000Z',
        }];
    let called = false;
    const provider = {
        name: 'fake',
        async createMessage() {
            called = true;
            return { content: '', toolCalls: [] };
        },
    };
    const result = await autoCompactIfNeeded({
        records,
        provider,
        model: 'fake-model',
        tools: [],
        contextManagement: {
            contextWindow: 10_000,
            summaryOutputTokens: 100,
            autoCompactBufferTokens: 50,
        },
        appendRecord: async () => { },
    });
    assert.equal(result.compacted, false);
    assert.equal(called, false);
});
test('autoCompactIfNeeded prefers last model usage token count over rough estimates', async () => {
    const records = [{
            type: 'message',
            id: 'user',
            role: 'user',
            content: 'short',
            createdAt: '2026-05-10T00:00:00.000Z',
        }, {
            type: 'message',
            id: 'latest-user',
            role: 'user',
            content: 'latest request',
            createdAt: '2026-05-10T00:01:00.000Z',
        }];
    let called = false;
    const appended = [];
    const provider = {
        name: 'fake',
        async createMessage() {
            called = true;
            return {
                content: 'usage-triggered summary',
                toolCalls: [],
                usage: {
                    cacheReadInputTokens: 0,
                    inputTokens: 1,
                    outputTokens: 1,
                },
            };
        },
    };
    const result = await autoCompactIfNeeded({
        records,
        provider,
        model: 'fake-model',
        tools: [],
        contextManagement: {
            contextWindow: 600,
            summaryOutputTokens: 100,
            autoCompactBufferTokens: 50,
        },
        lastUsageTokenCount: 500,
        appendRecord: async (record) => { appended.push(record); },
    });
    assert.equal(called, true);
    assert.equal(result.compacted, true);
    assert.equal(appended[0]?.type, 'compact_boundary');
});
