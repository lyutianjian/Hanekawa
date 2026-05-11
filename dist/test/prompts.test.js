import test from 'node:test';
import assert from 'node:assert/strict';
import { countMessageTokens, countMessagesTokens, getAutoCompactThreshold, getEffectiveContextWindowSize, getManualCompactThreshold, selectContextItemsForContext, selectMessagesForContext, } from '../src/prompts/budget.js';
import { PromptComposer } from '../src/prompts/composer.js';
test('context management counts tokens', () => {
    const msg = {
        id: '1',
        role: 'user',
        content: 'Hello world',
        createdAt: new Date().toISOString(),
    };
    const tokens = countMessageTokens(msg);
    assert.ok(tokens > 0);
    const multiTokens = countMessagesTokens([msg, msg]);
    assert.equal(multiTokens.messages.length, 2);
    assert.ok(multiTokens.total > tokens);
});
test('context management thresholds follow Claude Code style defaults', () => {
    assert.equal(getEffectiveContextWindowSize(), 180_000);
    assert.equal(getAutoCompactThreshold(), 167_000);
    assert.equal(getManualCompactThreshold(), 177_000);
});
test('context management selects messages within configured window', () => {
    const messages = [
        { id: '1', role: 'user', content: 'Short', createdAt: new Date().toISOString() },
        { id: '2', role: 'user', content: 'A'.repeat(500), createdAt: new Date().toISOString() },
        { id: '3', role: 'user', content: 'Should be truncated', createdAt: new Date().toISOString() },
    ];
    const truncated = selectMessagesForContext(messages, { contextWindow: 100, summaryOutputTokens: 0 });
    assert.ok(truncated.length < messages.length);
});
test('context management keeps newest context items and repairs tool pairing', () => {
    const items = [
        {
            kind: 'message',
            message: { id: 'old', role: 'user', content: 'old '.repeat(2000), createdAt: new Date().toISOString() },
        },
        {
            kind: 'message',
            message: { id: 'new', role: 'user', content: 'read file', createdAt: new Date().toISOString() },
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
    ];
    const truncated = selectContextItemsForContext(items, { contextWindow: 1100, summaryOutputTokens: 0 });
    assert.ok(!truncated.some((item) => item.kind === 'message' && item.message.id === 'old'));
    assert.ok(truncated.some((item) => item.kind === 'message' && item.message.id === 'new'));
    assert.ok(truncated.some((item) => item.kind === 'tool_use' && item.id === 'call-1'));
    assert.ok(truncated.some((item) => item.kind === 'tool_result' && item.toolUseId === 'call-1'));
});
test('PromptComposer builds request messages', () => {
    const composer = new PromptComposer();
    const contextManagement = { contextWindow: 2000, summaryOutputTokens: 0 };
    const messages = [
        { id: '1', role: 'user', content: 'Hello', createdAt: new Date().toISOString() },
    ];
    const result = composer.compose(messages, { contextManagement, includeHistory: true });
    assert.equal(result.messages.length, 1);
    assert.equal(result.messages[0].content, 'Hello');
    const noHistory = composer.compose(messages, { contextManagement, includeHistory: false });
    assert.equal(noHistory.messages.length, 0);
});
test('PromptComposer builds request context items', () => {
    const composer = new PromptComposer();
    const contextManagement = { contextWindow: 2000, summaryOutputTokens: 0 };
    const message = {
        id: '1',
        role: 'user',
        content: 'Hello',
        createdAt: new Date().toISOString(),
    };
    const result = composer.composeContextItems([{ kind: 'message', message }], { contextManagement, includeHistory: true });
    assert.equal(result.messages.length, 1);
    assert.equal(result.contextItems.length, 1);
    const noHistory = composer.composeContextItems([{ kind: 'message', message }], { contextManagement, includeHistory: false });
    assert.equal(noHistory.messages.length, 0);
    assert.equal(noHistory.contextItems.length, 0);
});
