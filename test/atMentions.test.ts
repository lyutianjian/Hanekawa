import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile as execFileCallback } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import {
  buildAtMentionContextRecord,
  extractAtMentionedFiles,
  parseAtMentionedFileLines,
} from '../src/harness/atMentions.js'
import type { ToolContext } from '../src/harness/types.js'

const execFile = promisify(execFileCallback)

function context(cwd: string): ToolContext {
  return {
    cwd,
    sessionId: 's1',
    readFiles: new Set(),
    readFileState: new Map(),
  }
}

test('extractAtMentionedFiles parses regular, quoted, line ranges, and deduplicates', () => {
  const mentions = extractAtMentionedFiles('read @src/a.py @src/a.py @"src/with space.cpp"#L3-4 @"src/b.ts" @src/c.ts#L10-20')

  assert.deepEqual(mentions.map((mention) => mention.filePath), [
    'src/with space.cpp',
    'src/b.ts',
    'src/a.py',
    'src/c.ts',
  ])
  assert.deepEqual(mentions[0], {
    raw: 'src/with space.cpp#L3-4',
    filePath: 'src/with space.cpp',
    lineStart: 3,
    lineEnd: 4,
  })
  assert.deepEqual(parseAtMentionedFileLines('src/c.ts#L10-20'), {
    filePath: 'src/c.ts',
    lineStart: 10,
    lineEnd: 20,
  })
})

test('buildAtMentionContextRecord injects code file content and updates read state', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hanekawa-at-'))
  try {
    await mkdir(path.join(dir, 'src'))
    const file = path.join(dir, 'src', 'a.py')
    await writeFile(file, 'one\ntwo\nthree\n', 'utf8')
    const ctx = context(dir)

    const record = await buildAtMentionContextRecord({
      userInput: 'explain @src/a.py#L2-3',
      userMessageId: 'u1',
      turnId: 't1',
      toolContext: ctx,
      createdAt: '2026-06-02T00:00:00.000Z',
    })

    assert.ok(record)
    assert.equal(record.type, 'at_mention_context')
    assert.match(record.content, /<file path="src\/a.py" lines="2-3">/)
    assert.match(record.content, /two\nthree/)
    assert.equal(ctx.readFiles.has(file), true)
    assert.equal(ctx.readFileState?.get(file)?.content, 'one\ntwo\nthree\n')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('buildAtMentionContextRecord skips non-code, empty directories, protected paths, and cwd escapes', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hanekawa-at-'))
  const outside = await mkdtemp(path.join(os.tmpdir(), 'hanekawa-out-'))
  try {
    await mkdir(path.join(dir, 'src'))
    await writeFile(path.join(dir, 'src', 'note.txt'), 'nope', 'utf8')
    await writeFile(path.join(dir, '.env'), 'SECRET=1', 'utf8')
    await writeFile(path.join(outside, 'x.py'), 'print(1)', 'utf8')

    const record = await buildAtMentionContextRecord({
      userInput: `@src @src/note.txt @.env @${path.relative(dir, path.join(outside, 'x.py'))}`,
      userMessageId: 'u1',
      turnId: 't1',
      toolContext: context(dir),
    })

    assert.equal(record, undefined)
  } finally {
    await rm(dir, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})

test('buildAtMentionContextRecord expands mentioned directories to code files', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hanekawa-at-'))
  try {
    await mkdir(path.join(dir, 'src', 'nested'), { recursive: true })
    await writeFile(path.join(dir, 'src', 'a.py'), 'print(1)\n', 'utf8')
    await writeFile(path.join(dir, 'src', 'nested', 'b.ts'), 'export {}\n', 'utf8')
    await writeFile(path.join(dir, 'src', 'note.txt'), 'nope\n', 'utf8')
    const ctx = context(dir)

    const record = await buildAtMentionContextRecord({
      userInput: '@src/',
      userMessageId: 'u1',
      turnId: 't1',
      toolContext: ctx,
    })

    assert.ok(record)
    assert.deepEqual(record.files.map((file) => file.displayPath), [
      'src/a.py',
      'src/nested/b.ts',
    ])
    assert.match(record.content, /<file path="src\/a.py"/)
    assert.match(record.content, /<file path="src\/nested\/b.ts"/)
    assert.doesNotMatch(record.content, /note.txt/)
    assert.equal(ctx.readFiles.has(path.join(dir, 'src', 'a.py')), true)
    assert.equal(ctx.readFiles.has(path.join(dir, 'src', 'nested', 'b.ts')), true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('buildAtMentionContextRecord skips gitignored directory files', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hanekawa-at-'))
  try {
    await execFile('git', ['init'], { cwd: dir })
    await mkdir(path.join(dir, 'src'))
    await writeFile(path.join(dir, '.gitignore'), 'src/ignored.py\n', 'utf8')
    await writeFile(path.join(dir, 'src', 'ignored.py'), 'print("ignored")\n', 'utf8')
    await writeFile(path.join(dir, 'src', 'visible.py'), 'print("visible")\n', 'utf8')

    const record = await buildAtMentionContextRecord({
      userInput: '@src/',
      userMessageId: 'u1',
      turnId: 't1',
      toolContext: context(dir),
    })

    assert.ok(record)
    assert.deepEqual(record.files.map((file) => file.displayPath), ['src/visible.py'])
    assert.match(record.content, /visible/)
    assert.doesNotMatch(record.content, /ignored/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('buildAtMentionContextRecord truncates large attached content', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hanekawa-at-'))
  try {
    const content = Array.from({ length: 2_100 }, (_, index) => `line ${index + 1}`).join('\n')
    await writeFile(path.join(dir, 'big.py'), content, 'utf8')

    const record = await buildAtMentionContextRecord({
      userInput: '@big.py',
      userMessageId: 'u1',
      turnId: 't1',
      toolContext: context(dir),
    })

    assert.ok(record)
    assert.equal(record.files[0]?.lineStart, 1)
    assert.equal(record.files[0]?.lineEnd, 2000)
    assert.equal(record.files[0]?.truncated, true)
    assert.match(record.content, /\[... @-mentioned file content truncated ...\]/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
