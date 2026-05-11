import test from 'node:test';
import assert from 'node:assert/strict';
import { ContextBuilder } from '../src/harness/contextBuilder.js';
const contextWindow = (contextWindow) => ({ contextWindow, summaryOutputTokens: 0 });
const tool = {
    name: 'readFile',
    description: 'Read a file from disk',
    inputSchema: {},
    riskLevel: 'safe',
    execute: async () => ({ ok: true, content: '' }),
};
test('ContextBuilder injects layered system and user context', () => {
    const builder = new ContextBuilder(undefined, contextWindow(5000));
    const records = [{
            type: 'message',
            id: 'u1',
            role: 'user',
            content: 'hello',
            createdAt: '2026-05-10T00:00:00.000Z',
        }];
    const built = builder.build({
        records,
        tools: [tool],
        system: 'custom system',
        now: new Date('2026-05-10T12:00:00.000Z'),
    });
    assert.match(built.system ?? '', /custom system/);
    assert.match(built.system ?? '', /You are Hanekawa/);
    assert.match(built.system ?? '', /lyutianjian/);
    assert.match(built.system ?? '', /# Doing tasks/);
    assert.match(built.system ?? '', /# Using your tools/);
    assert.match(built.system ?? '', /Prefer dedicated tools over Bash/);
    assert.deepEqual(built.systemBlocks?.map((block) => block.slice(0, 40)), [
        'You are Hanekawa, an interactive CLI age',
        'You are an interactive agent that helps ',
        'custom system',
    ]);
    assert.equal(built.contextItems[0]?.kind, 'message');
    const first = built.contextItems[0];
    assert.equal(first.kind, 'message');
    assert.equal(first.message.id, 'meta:user-context');
    assert.match(first.message.content, /Today's date is 2026\/05\/10/);
    assert.match(first.message.content, /readFile: Read a file from disk/);
});
test('ContextBuilder injects available skills as system reminder', () => {
    const builder = new ContextBuilder(undefined, contextWindow(5000));
    const built = builder.build({
        records: [],
        tools: [{
                ...tool,
                name: 'Skill',
                description: 'Execute a skill within the main conversation',
            }],
        skills: [
            { name: 'debugging', description: 'Use when diagnosing bugs', content: 'Debug content' },
            { name: 'tdd', description: 'Test-driven development', content: 'TDD content' },
        ],
        now: new Date('2026-05-10T12:00:00.000Z'),
    });
    const first = built.contextItems[0];
    assert.equal(first?.kind, 'message');
    assert.match(first.message.content, /The following skills are available for use with the Skill tool/);
    assert.match(first.message.content, /- debugging: Use when diagnosing bugs/);
    assert.match(first.message.content, /- tdd: Test-driven development/);
    assert.match(first.message.content, /Skill: Execute a skill within the main conversation/);
    assert.doesNotMatch(first.message.content, /skill_debugging/);
});
test('ContextBuilder budgets messages and tool records together', () => {
    const builder = new ContextBuilder(undefined, contextWindow(7000));
    const records = [
        {
            type: 'message',
            id: 'old',
            role: 'user',
            content: 'old '.repeat(8000),
            createdAt: '2026-05-10T00:00:00.000Z',
        },
        {
            type: 'message',
            id: 'new',
            role: 'user',
            content: 'read it',
            createdAt: '2026-05-10T00:01:00.000Z',
        },
        {
            type: 'tool_use',
            id: 'call-1',
            tool: 'readFile',
            input: { filePath: 'a.txt' },
            riskLevel: 'safe',
            createdAt: '2026-05-10T00:02:00.000Z',
        },
        {
            type: 'tool_result',
            id: 'result-1',
            toolUseId: 'call-1',
            tool: 'readFile',
            ok: true,
            content: 'file body',
            createdAt: '2026-05-10T00:03:00.000Z',
        },
    ];
    const built = builder.build({
        records,
        tools: [],
        includeUserContext: false,
    });
    assert.ok(!built.contextItems.some((item) => item.kind === 'message' && item.message.id === 'old'));
    assert.ok(built.contextItems.some((item) => item.kind === 'message' && item.message.id === 'new'));
    assert.ok(built.contextItems.some((item) => item.kind === 'tool_use' && item.id === 'call-1'));
    assert.ok(built.contextItems.some((item) => item.kind === 'tool_result' && item.toolUseId === 'call-1'));
});
test('ContextBuilder uses latest compact boundary as prior context summary', () => {
    const builder = new ContextBuilder(undefined, contextWindow(5000));
    const records = [
        {
            type: 'message',
            id: 'old',
            role: 'user',
            content: 'old detail',
            createdAt: '2026-05-10T00:00:00.000Z',
        },
        {
            type: 'compact_boundary',
            id: 'compact-1',
            summary: 'summary of old detail',
            preTokens: 1234,
            createdAt: '2026-05-10T00:01:00.000Z',
        },
        {
            type: 'message',
            id: 'new',
            role: 'user',
            content: 'new detail',
            createdAt: '2026-05-10T00:02:00.000Z',
        },
    ];
    const built = builder.build({
        records,
        tools: [],
        includeUserContext: false,
    });
    assert.ok(!built.contextItems.some((item) => item.kind === 'message' && item.message.id === 'old'));
    assert.ok(built.contextItems.some((item) => item.kind === 'message' && item.message.id === 'compact-1' && /summary of old detail/.test(item.message.content)));
    assert.ok(built.contextItems.some((item) => item.kind === 'message' && item.message.id === 'new'));
});
test('ContextBuilder restores recent file and skill context after compact boundary', () => {
    const builder = new ContextBuilder(undefined, contextWindow(50_000));
    const records = [{
            type: 'compact_boundary',
            id: 'compact-1',
            summary: 'summary',
            preTokens: 1234,
            createdAt: '2026-05-10T00:01:00.000Z',
        }];
    const built = builder.build({
        records,
        tools: [],
        includeUserContext: false,
        toolContext: {
            cwd: process.cwd(),
            sessionId: 's1',
            readFiles: new Set(),
            readFileState: new Map([
                ['C:\\project\\a.ts', { content: 'export const a = 1', timestamp: 10 }],
            ]),
            invokedSkills: new Map([
                ['debugging', { content: 'Debug skill body', timestamp: 20 }],
            ]),
        },
    });
    const restore = built.contextItems.find((item) => item.kind === 'message' && item.message.id === 'meta:post-compact-restore');
    assert.equal(restore?.kind, 'message');
    assert.match(restore.message.content, /restoredFile C:\\project\\a.ts/);
    assert.match(restore.message.content, /export const a = 1/);
    assert.match(restore.message.content, /restoredSkill debugging/);
    assert.match(restore.message.content, /Debug skill body/);
});
test('ContextBuilder limits restored files by recency and budget', () => {
    const builder = new ContextBuilder(undefined, contextWindow(50_000));
    const readFileState = new Map();
    for (let index = 0; index < 7; index++) {
        readFileState.set(`C:\\project\\file-${index}.ts`, {
            content: `file ${index}`,
            timestamp: index,
        });
    }
    const built = builder.build({
        records: [{
                type: 'compact_boundary',
                id: 'compact-1',
                summary: 'summary',
                preTokens: 1234,
                createdAt: '2026-05-10T00:01:00.000Z',
            }],
        tools: [],
        includeUserContext: false,
        toolContext: {
            cwd: process.cwd(),
            sessionId: 's1',
            readFiles: new Set(),
            readFileState,
        },
    });
    const restore = built.contextItems.find((item) => item.kind === 'message' && item.message.id === 'meta:post-compact-restore');
    assert.equal(restore?.kind, 'message');
    assert.equal((restore.message.content.match(/# restoredFile/g) ?? []).length, 5);
    assert.match(restore.message.content, /file-6/);
    assert.doesNotMatch(restore.message.content, /file-0/);
});
test('ContextBuilder injects environment context when env is provided', () => {
    const builder = new ContextBuilder(undefined, contextWindow(5000));
    const built = builder.build({
        records: [],
        tools: [tool],
        env: {
            cwd: '/home/user/project',
            platform: 'linux',
            shell: 'bash',
            osVersion: 'Linux 6.1.0',
            isGitRepo: true,
            model: 'claude-opus-4-7',
        },
        now: new Date('2026-05-10T12:00:00.000Z'),
    });
    const first = built.contextItems[0];
    assert.equal(first?.kind, 'message');
    assert.match(first.message.content, /# Environment/);
    assert.match(first.message.content, /Primary working directory: \/home\/user\/project/);
    assert.match(first.message.content, /Is a git repository: true/);
    assert.match(first.message.content, /Platform: linux/);
    assert.match(first.message.content, /Shell: bash/);
    assert.match(first.message.content, /OS Version: Linux 6\.1\.0/);
    assert.match(first.message.content, /powered by the model claude-opus-4-7/);
});
test('ContextBuilder omits environment context when env is not provided', () => {
    const builder = new ContextBuilder(undefined, contextWindow(5000));
    const built = builder.build({
        records: [],
        tools: [tool],
        now: new Date('2026-05-10T12:00:00.000Z'),
    });
    const first = built.contextItems[0];
    assert.equal(first?.kind, 'message');
    assert.doesNotMatch(first.message.content, /# Environment/);
    assert.doesNotMatch(first.message.content, /Primary working directory/);
});
