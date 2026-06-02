import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { z } from 'zod/v3'
import { ContextBuilder } from '../src/harness/contextBuilder.js'
import type { ReadFileState, SessionRecord, Tool } from '../src/harness/types.js'

const contextWindow = (contextWindow: number) => ({ contextWindow, summaryOutputTokens: 0 })

const tool: Tool = {
  name: 'Read',
  description: 'Read a file from disk',
  inputSchema: z.object({}).strict(),
  riskLevel: 'safe',
  execute: async () => ({ ok: true, content: '' }),
}

test('ContextBuilder injects layered system and user context', async () => {
  const builder = new ContextBuilder(undefined, contextWindow(8000))
  const records: SessionRecord[] = [{
    type: 'message',
    id: 'u1',
    role: 'user',
    content: 'hello',
    createdAt: '2026-05-10T00:00:00.000Z',
  }]

  const built = await builder.build({
    records,
    tools: [tool],
    system: 'custom system',
    now: new Date('2026-05-10T12:00:00.000Z'),
  })

  assert.match(built.system ?? '', /custom system/)
  assert.match(built.system ?? '', /You are Hanekawa/)
  assert.match(built.system ?? '', /lyutianjian/)
  assert.match(built.system ?? '', /# Doing tasks/)
  assert.match(built.system ?? '', /# Using your tools/)
  assert.match(built.system ?? '', /Prefer dedicated tools over Bash/)
  assert.deepEqual(built.systemBlocks?.map((block) => block.slice(0, 40)), [
    'You are Hanekawa, an interactive CLI age',
    '# System\n - All text you output outside ',
    '# Doing tasks\n - The user will primarily',
    '# Executing actions with care\n\nCarefully',
    '# Using your tools\n - Prefer dedicated t',
    '# Tone and style\n - Only use emojis if t',
    '# Text output (does not apply to tool ca',
    '# availableTools\n- Read: Read a file fro',
    '__MYAGENT_SYSTEM_PROMPT_DYNAMIC_BOUNDARY',
    'custom system',
  ])
  assert.equal(built.contextItems[0]?.kind, 'message')
  const first = built.contextItems[0]
  assert.equal(first.kind, 'message')
  assert.equal(first.message.id, 'meta:user-context')
  assert.match(first.message.content, /Today's date is 2026\/05\/10/)
  assert.doesNotMatch(first.message.content, /Read: Read a file from disk/)
  assert.match(built.system ?? '', /Read: Read a file from disk/)
})

test('ContextBuilder can build a reduced system prompt from enabled sections', async () => {
  const builder = new ContextBuilder(undefined, contextWindow(5000), undefined, ['intro', 'doing-tasks'])

  const built = await builder.build({
    records: [],
    tools: [],
    includeUserContext: false,
  })

  assert.match(built.system ?? '', /You are Hanekawa/)
  assert.match(built.system ?? '', /# Doing tasks/)
  assert.doesNotMatch(built.system ?? '', /# Using your tools/)
  assert.doesNotMatch(built.system ?? '', /# Tone and style/)
  assert.deepEqual(built.systemBlocks?.map((block) => block.slice(0, 40)), [
    'You are Hanekawa, an interactive CLI age',
    '# Doing tasks\n - The user will primarily',
  ])
})

test('ContextBuilder injects at-mention context records as hidden user context', async () => {
  const builder = new ContextBuilder(undefined, contextWindow(5000))
  const records: SessionRecord[] = [
    {
      type: 'message',
      id: 'u1',
      role: 'user',
      content: 'explain @src/a.py',
      createdAt: '2026-06-02T00:00:00.000Z',
    },
    {
      type: 'at_mention_context',
      id: 'at1',
      userMessageId: 'u1',
      turnId: 't1',
      createdAt: '2026-06-02T00:00:01.000Z',
      files: [{
        path: '/repo/src/a.py',
        displayPath: 'src/a.py',
        lineStart: 1,
        lineEnd: 1,
        truncated: false,
      }],
      content: '<system-reminder>\n<file path="src/a.py" lines="1-1">\nprint(1)\n</file>\n</system-reminder>',
    },
  ]

  const built = await builder.build({
    records,
    tools: [],
    includeUserContext: false,
  })

  const context = built.contextItems.filter((item) => item.kind === 'message').map((item) => item.message.content).join('\n')
  assert.match(context, /<file path="src\/a.py" lines="1-1">/)
  assert.match(context, /print\(1\)/)
})

test('ContextBuilder build input can override enabled system sections', async () => {
  const builder = new ContextBuilder(undefined, contextWindow(5000), undefined, ['intro', 'system'])

  const built = await builder.build({
    records: [],
    tools: [],
    includeUserContext: false,
    enabledSections: ['using-tools'],
  })

  assert.doesNotMatch(built.system ?? '', /You are Hanekawa/)
  assert.doesNotMatch(built.system ?? '', /# System/)
  assert.match(built.system ?? '', /# Using your tools/)
})

test('ContextBuilder adds a dynamic plan mode reminder', async () => {
  const builder = new ContextBuilder(undefined, contextWindow(5000))

  const built = await builder.build({
    records: [],
    tools: [],
    includeUserContext: false,
    permissionMode: 'plan',
  })

  assert.match(built.system ?? '', /You are in plan mode/)
  assert.match(built.system ?? '', /Use AskUserQuestion if you need to clarify approaches/)
  assert.match(built.system ?? '', /Exit plan mode with ExitPlanMode when ready to implement/)
  assert.match(built.system ?? '', /Ordinary assistant-text plans are invalid/)
  assert.equal(built.systemBlocks?.at(-2), '__MYAGENT_SYSTEM_PROMPT_DYNAMIC_BOUNDARY__')
  assert.match(built.systemBlocks?.at(-1) ?? '', /What Happens in Plan Mode/)
  assert.match(built.systemBlocks?.at(-1) ?? '', /ExitPlanMode inherently requests user approval/)
})

test('ContextBuilder injects available skills as system reminder', async () => {
  const builder = new ContextBuilder(undefined, contextWindow(5000))

  const built = await builder.build({
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
  })

  const first = built.contextItems[0]
  assert.equal(first?.kind, 'message')
  assert.doesNotMatch(first.message.content, /The following skills are available for use with the Skill tool/)
  assert.match(built.system ?? '', /The following skills are available for use with the Skill tool/)
  assert.match(built.system ?? '', /- debugging: Use when diagnosing bugs/)
  assert.match(built.system ?? '', /- tdd: Test-driven development/)
  assert.match(built.system ?? '', /Skill: Execute a skill within the main conversation/)
  assert.doesNotMatch(built.system ?? '', /skill_debugging/)
})

test('ContextBuilder invalidates cached skills section when skills change', async () => {
  const builder = new ContextBuilder(undefined, contextWindow(5000))

  const first = await builder.build({
    records: [],
    tools: [],
    skills: [
      { name: 'debugging', description: 'Use when diagnosing bugs', content: 'Debug content' },
    ],
    includeUserContext: false,
  })
  const second = await builder.build({
    records: [],
    tools: [],
    skills: [
      { name: 'review', description: 'Use when reviewing code', content: 'Review content' },
    ],
    includeUserContext: false,
  })

  assert.match(first.system ?? '', /- debugging: Use when diagnosing bugs/)
  assert.match(second.system ?? '', /- review: Use when reviewing code/)
  assert.doesNotMatch(second.system ?? '', /debugging/)
})

test('ContextBuilder activates file-matched skills from read files', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-context-'))
  const builder = new ContextBuilder(undefined, contextWindow(5000))
  try {
    const file = path.join(dir, 'src', 'App.tsx')
    const toolContext = {
      cwd: dir,
      sessionId: 's1',
      readFiles: new Set<string>([file]),
      invokedSkills: new Map<string, { content: string; timestamp: number }>(),
    }

    const built = await builder.build({
      records: [],
      tools: [],
      skills: [
        {
          name: 'react',
          description: 'React guidance',
          content: 'Prefer small components.',
          inclusion: 'fileMatch',
          paths: ['src/**/*.tsx'],
        },
        {
          name: 'sql',
          description: 'SQL guidance',
          content: 'Use parameterized queries.',
          inclusion: 'fileMatch',
          paths: ['src/**/*.sql'],
        },
      ],
      toolContext,
      now: new Date('2026-05-10T12:00:00.000Z'),
    })

    const userContext = built.contextItems[0]
    assert.equal(userContext?.kind, 'message')
    assert.match(userContext.message.content, /# activeSkills/)
    assert.match(userContext.message.content, /## react/)
    assert.match(userContext.message.content, /Prefer small components\./)
    assert.doesNotMatch(userContext.message.content, /Use parameterized queries/)
    assert.equal(toolContext.invokedSkills.get('react')?.content, 'Prefer small components.')
    assert.equal(toolContext.invokedSkills.has('sql'), false)
    assert.doesNotMatch(built.system ?? '', /react: React guidance/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('ContextBuilder gives file-matched skills lower restore priority than manual skills', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-context-'))
  const originalNow = Date.now
  Date.now = () => 1_000_000_000
  try {
    const file = path.join(dir, 'src', 'App.tsx')
    const toolContext = {
      cwd: dir,
      sessionId: 's1',
      readFiles: new Set<string>([file]),
      invokedSkills: new Map<string, { content: string; timestamp: number }>([
        ['manual', { content: 'Manual content.', timestamp: 900_000_000 }],
        ['react', { content: 'Previously manual react content.', timestamp: 800_000_000 }],
      ]),
    }
    const builder = new ContextBuilder(undefined, contextWindow(5000))

    await builder.build({
      records: [],
      tools: [],
      skills: [
        {
          name: 'react',
          description: 'React guidance',
          content: 'Prefer small components.',
          inclusion: 'fileMatch',
          paths: ['src/**/*.tsx'],
        },
        {
          name: 'sql',
          description: 'SQL guidance',
          content: 'Use parameterized queries.',
          inclusion: 'fileMatch',
          paths: ['src/**/*.tsx'],
        },
      ],
      toolContext,
      includeUserContext: false,
    })

    assert.equal(toolContext.invokedSkills.get('react')?.timestamp, 800_000_000)
    assert.equal(toolContext.invokedSkills.get('sql')?.timestamp, 913_600_000)
    assert.equal(toolContext.invokedSkills.get('manual')?.timestamp, 900_000_000)
  } finally {
    Date.now = originalNow
    await rm(dir, { recursive: true, force: true })
  }
})

test('ContextBuilder budgets messages and tool records together', async () => {
  const builder = new ContextBuilder(undefined, contextWindow(7000))
  const records: SessionRecord[] = [
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
      tool: 'Read',
      input: { filePath: 'a.txt' },
      riskLevel: 'safe',
      createdAt: '2026-05-10T00:02:00.000Z',
    },
    {
      type: 'tool_result',
      id: 'result-1',
      toolUseId: 'call-1',
      tool: 'Read',
      ok: true,
      content: 'file body',
      createdAt: '2026-05-10T00:03:00.000Z',
    },
  ]

  const built = await builder.build({
    records,
    tools: [],
    includeUserContext: false,
  })

  assert.ok(!built.contextItems.some((item) => item.kind === 'message' && item.message.id === 'old'))
  assert.ok(built.contextItems.some((item) => item.kind === 'message' && item.message.id === 'new'))
  assert.ok(built.contextItems.some((item) => item.kind === 'tool_use' && item.id === 'call-1'))
  assert.ok(built.contextItems.some((item) => item.kind === 'tool_result' && item.toolUseId === 'call-1'))
})

test('ContextBuilder prepends preloaded history before child records', async () => {
  const builder = new ContextBuilder(undefined, contextWindow(8000))
  const preloadRecords: SessionRecord[] = [{
    type: 'message',
    id: 'parent-message',
    role: 'user',
    content: 'parent context',
    createdAt: '2026-05-10T00:00:00.000Z',
  }]
  const records: SessionRecord[] = [{
    type: 'message',
    id: 'child-directive',
    role: 'user',
    content: 'child directive',
    createdAt: '2026-05-10T00:01:00.000Z',
  }]

  const originalPreload = [...preloadRecords]
  const built = await builder.build({
    preloadRecords,
    records,
    tools: [],
    includeUserContext: false,
  })

  assert.deepEqual(preloadRecords, originalPreload)
  assert.deepEqual(
    built.contextItems
      .filter((item) => item.kind === 'message')
      .map((item) => item.message.id),
    ['parent-message', 'child-directive'],
  )
})

test('ContextBuilder uses latest compact boundary as prior context summary', async () => {
  const builder = new ContextBuilder(undefined, contextWindow(8000))
  const records: SessionRecord[] = [
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
  ]

  const built = await builder.build({
    records,
    tools: [],
    includeUserContext: false,
  })

  assert.ok(!built.contextItems.some((item) => item.kind === 'message' && item.message.id === 'old'))
  assert.ok(built.contextItems.some((item) => item.kind === 'message' && item.message.id === 'compact-1' && /summary of old detail/.test(item.message.content)))
  assert.ok(built.contextItems.some((item) => item.kind === 'message' && item.message.id === 'new'))
})

test('ContextBuilder restores recent file and skill context after compact boundary', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-context-'))
  const builder = new ContextBuilder(undefined, contextWindow(50_000))
  try {
    const file = path.join(dir, 'a.ts')
    await writeFile(file, 'export const a = 2', 'utf8')
    const records: SessionRecord[] = [{
      type: 'compact_boundary',
      id: 'compact-1',
      summary: 'summary',
      preTokens: 1234,
      createdAt: '2026-05-10T00:01:00.000Z',
    }]

    const toolContext = {
      cwd: dir,
      sessionId: 's1',
      readFiles: new Set<string>(),
      readFileState: new Map<string, ReadFileState>([
        [file, { content: 'export const a = 1', timestamp: 10, mtimeMs: 10, size: 18 }],
      ]),
      invokedSkills: new Map([
        ['debugging', { content: 'Debug skill body', timestamp: 20 }],
      ]),
    }
    const built = await builder.build({
      records,
      tools: [],
      includeUserContext: false,
      toolContext,
      includePostCompactRestore: true,
    })

    const restore = built.contextItems.find((item) => item.kind === 'message' && item.message.id === 'meta:post-compact-restore')
    assert.equal(restore?.kind, 'message')
    assert.ok(restore.message.content.includes(`# restoredFile ${file}`))
    assert.match(restore.message.content, /export const a = 2/)
    assert.doesNotMatch(restore.message.content, /export const a = 1/)
    assert.equal(toolContext.readFileState.get(file)?.content, 'export const a = 2')
    assert.match(restore.message.content, /restoredSkill debugging/)
    assert.match(restore.message.content, /Debug skill body/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('ContextBuilder does not restore compact context unless explicitly requested', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-context-'))
  const builder = new ContextBuilder(undefined, contextWindow(50_000))
  try {
    const file = path.join(dir, 'a.ts')
    await writeFile(file, 'export const a = 2', 'utf8')
    const toolContext = {
      cwd: dir,
      sessionId: 's1',
      readFiles: new Set<string>(),
      readFileState: new Map<string, ReadFileState>([
        [file, { content: 'export const a = 1', timestamp: 10, mtimeMs: 10, size: 18 }],
      ]),
    }

    const built = await builder.build({
      records: [{
        type: 'compact_boundary',
        id: 'compact-1',
        summary: 'summary',
        preTokens: 1234,
        createdAt: '2026-05-10T00:01:00.000Z',
      }],
      tools: [],
      includeUserContext: false,
      toolContext,
    })

    assert.ok(!built.contextItems.some((item) => item.kind === 'message' && item.message.id === 'meta:post-compact-restore'))
    assert.equal(toolContext.readFileState.get(file)?.content, 'export const a = 1')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('ContextBuilder limits restored files by recency and budget', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-context-'))
  const builder = new ContextBuilder(undefined, contextWindow(50_000))
  try {
    const readFileState = new Map<string, ReadFileState>()
    for (let index = 0; index < 7; index++) {
      const file = path.join(dir, `file-${index}.ts`)
      await writeFile(file, `file ${index}`, 'utf8')
      readFileState.set(file, {
        content: `stale ${index}`,
        timestamp: index,
        mtimeMs: index,
        size: 6,
      })
    }

    const built = await builder.build({
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
        cwd: dir,
        sessionId: 's1',
        readFiles: new Set(),
        readFileState,
      },
      includePostCompactRestore: true,
    })

    const restore = built.contextItems.find((item) => item.kind === 'message' && item.message.id === 'meta:post-compact-restore')
    assert.equal(restore?.kind, 'message')
    assert.equal((restore.message.content.match(/# restoredFile/g) ?? []).length, 5)
    assert.match(restore.message.content, /file-6/)
    assert.doesNotMatch(restore.message.content, /file-0/)
    assert.doesNotMatch(restore.message.content, /stale 6/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('ContextBuilder applies restore file budget after refreshing from disk', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-context-'))
  const builder = new ContextBuilder(undefined, contextWindow(50_000))
  try {
    const file = path.join(dir, 'large.ts')
    await writeFile(file, 'x'.repeat(30_000), 'utf8')

    const built = await builder.build({
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
        cwd: dir,
        sessionId: 's1',
        readFiles: new Set(),
        readFileState: new Map<string, ReadFileState>([
          [file, { content: 'small cached content', timestamp: 1, mtimeMs: 1, size: 20 }],
        ]),
      },
      includePostCompactRestore: true,
    })

    const restore = built.contextItems.find((item) => item.kind === 'message' && item.message.id === 'meta:post-compact-restore')
    assert.equal(restore?.kind, 'message')
    assert.match(restore.message.content, /\[\.\.\. restored content truncated for context budget \.\.\.\]/)
    assert.ok(restore.message.content.length < 30_000)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('ContextBuilder notes restored files that are no longer accessible', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-context-'))
  const builder = new ContextBuilder(undefined, contextWindow(50_000))
  try {
    const file = path.join(dir, 'missing.ts')
    const toolContext = {
      cwd: dir,
      sessionId: 's1',
      readFiles: new Set<string>([file]),
      readFileState: new Map<string, ReadFileState>([
        [file, { content: 'export const a = 1', timestamp: 10, mtimeMs: 10, size: 18 }],
      ]),
    }

    const built = await builder.build({
      records: [{
        type: 'compact_boundary',
        id: 'compact-1',
        summary: 'summary',
        preTokens: 1234,
        createdAt: '2026-05-10T00:01:00.000Z',
      }],
      tools: [],
      includeUserContext: false,
      toolContext,
      includePostCompactRestore: true,
    })

    const restore = built.contextItems.find((item) => item.kind === 'message' && item.message.id === 'meta:post-compact-restore')
    assert.equal(restore?.kind, 'message')
    assert.match(restore.message.content, new RegExp(`previously read file ${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} is no longer accessible`))
    assert.equal(toolContext.readFiles.has(file), false)
    assert.equal(toolContext.readFileState.has(file), false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('ContextBuilder injects environment context when env is provided', async () => {
  const builder = new ContextBuilder(undefined, contextWindow(5000))

  const built = await builder.build({
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
  })

  const first = built.contextItems[0]
  assert.equal(first?.kind, 'message')
  assert.doesNotMatch(first.message.content, /# Environment/)
  assert.match(built.system ?? '', /# Environment/)
  assert.match(built.system ?? '', /Primary working directory: \/home\/user\/project/)
  assert.match(built.system ?? '', /Is a git repository: true/)
  assert.match(built.system ?? '', /Platform: linux/)
  assert.match(built.system ?? '', /Shell: bash/)
  assert.match(built.system ?? '', /OS Version: Linux 6\.1\.0/)
  assert.match(built.system ?? '', /powered by the model claude-opus-4-7/)
})

test('ContextBuilder omits environment context when env is not provided', async () => {
  const builder = new ContextBuilder(undefined, contextWindow(5000))

  const built = await builder.build({
    records: [],
    tools: [tool],
    now: new Date('2026-05-10T12:00:00.000Z'),
  })

  const first = built.contextItems[0]
  assert.equal(first?.kind, 'message')
  assert.doesNotMatch(first.message.content, /# Environment/)
  assert.doesNotMatch(first.message.content, /Primary working directory/)
})

test('ContextBuilder caches available tools until invalidated', async () => {
  const builder = new ContextBuilder(undefined, contextWindow(5000))
  const tools = [tool]

  const first = await builder.build({
    records: [],
    tools,
    now: new Date('2026-05-10T12:00:00.000Z'),
  })
  tools[0] = {
    ...tool,
    description: 'Changed after MCP reconnect',
  }
  const cached = await builder.build({
    records: [],
    tools,
    now: new Date('2026-05-10T12:01:00.000Z'),
  })
  builder.invalidateAvailableToolsSection()
  const refreshed = await builder.build({
    records: [],
    tools,
    now: new Date('2026-05-10T12:02:00.000Z'),
  })

  assert.match(first.system ?? '', /Read: Read a file from disk/)
  assert.match(cached.system ?? '', /Read: Read a file from disk/)
  assert.doesNotMatch(cached.system ?? '', /Changed after MCP reconnect/)
  assert.match(refreshed.system ?? '', /Read: Changed after MCP reconnect/)
})

test('ContextBuilder keeps currentDate dynamic while availableTools stays cached', async () => {
  const builder = new ContextBuilder(undefined, contextWindow(5000))

  const beforeMidnight = await builder.build({
    records: [],
    tools: [tool],
    now: new Date(2026, 4, 10, 23, 59),
  })
  const afterMidnight = await builder.build({
    records: [],
    tools: [tool],
    now: new Date(2026, 4, 11, 0, 1),
  })

  const before = beforeMidnight.contextItems[0]
  const after = afterMidnight.contextItems[0]
  assert.equal(before?.kind, 'message')
  assert.equal(after?.kind, 'message')
  assert.match(before.message.content, /Today's date is 2026\/05\/10/)
  assert.match(after.message.content, /Today's date is 2026\/05\/11/)
  assert.doesNotMatch(before.message.content, /Read: Read a file from disk/)
  assert.doesNotMatch(after.message.content, /Read: Read a file from disk/)
  assert.match(beforeMidnight.system ?? '', /Read: Read a file from disk/)
  assert.match(afterMidnight.system ?? '', /Read: Read a file from disk/)
  assert.doesNotMatch(beforeMidnight.system ?? '', /2026\/05\/10/)
  assert.doesNotMatch(afterMidnight.system ?? '', /2026\/05\/11/)
})
