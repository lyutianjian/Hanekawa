import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import type { ReadFileState } from '../src/harness/types.js'
import { grepTool } from '../src/tools/GrepTool/GrepTool.js'

function context(cwd: string) {
  return { cwd, sessionId: 's1', readFiles: new Set<string>(), readFileState: new Map<string, ReadFileState>() }
}

async function withProject(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-grep-'))
  try {
    await writeFile(path.join(dir, 'alpha.ts'), 'const target = 1\nconst other = 2\nconst target2 = 3\n', 'utf8')
    await writeFile(path.join(dir, 'beta.ts'), 'no hits here\n', 'utf8')
    await writeFile(path.join(dir, 'gamma.ts'), 'const target = 4\n', 'utf8')
    await run(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('outputMode files_with_matches returns paths without line numbers', async () => {
  await withProject(async (dir) => {
    const result = await grepTool.execute({ pattern: 'target', outputMode: 'files_with_matches' }, context(dir))
    assert.equal(result.ok, true, result.content)
    const rows = result.content.split('\n').sort()
    assert.deepEqual(rows, ['alpha.ts', 'gamma.ts'])
  })
})

test('outputMode count returns one path:count row per matching file', async () => {
  await withProject(async (dir) => {
    const result = await grepTool.execute({ pattern: 'target', outputMode: 'count' }, context(dir))
    assert.equal(result.ok, true, result.content)
    const rows = result.content.split('\n').sort()
    assert.deepEqual(rows, ['alpha.ts:2', 'gamma.ts:1'])
  })
})

test('contextLines widens content rows around each match', async () => {
  await withProject(async (dir) => {
    const result = await grepTool.execute({ pattern: 'other', path: 'alpha.ts', contextLines: 1 }, context(dir))
    assert.equal(result.ok, true, result.content)
    const rows = result.content.split('\n')
    assert.deepEqual(rows, [
      'alpha.ts:1:const target = 1',
      'alpha.ts:2:const other = 2',
      'alpha.ts:3:const target2 = 3',
    ])
  })
})

test('context lines are refused rather than ignored outside content mode', async () => {
  await withProject(async (dir) => {
    const result = await grepTool.execute({ pattern: 'target', outputMode: 'count', contextLines: 2 }, context(dir))
    assert.equal(result.ok, false)
    assert.equal(result.errorCode, 'invalid_input')
    assert.match(result.content, /outputMode "content"/)
  })
})

test('a pattern containing \\n retries as multiline instead of surfacing ripgrep stderr', async () => {
  await withProject(async (dir) => {
    const result = await grepTool.execute({ pattern: 'target = 1\\nconst other', path: 'alpha.ts' }, context(dir))
    assert.equal(result.ok, true, result.content)
    assert.match(result.content, /alpha\.ts:1:/)
    assert.doesNotMatch(result.content, /ripgrep failed/)
  })
})

test('the type filter narrows the search the way glob does', async () => {
  await withProject(async (dir) => {
    await writeFile(path.join(dir, 'delta.py'), 'target = 5\n', 'utf8')
    const result = await grepTool.execute({ pattern: 'target', type: 'py', outputMode: 'files_with_matches' }, context(dir))
    assert.equal(result.ok, true, result.content)
    assert.equal(result.content, 'delta.py')
  })
})
