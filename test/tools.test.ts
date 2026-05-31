import { mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import { getBuiltinTools } from '../src/tools/index.js'
import type { ReadFileState } from '../src/harness/types.js'
import { grepTool } from '../src/tools/grep.js'
import { bashTool } from '../src/tools/bash.js'
import { readFileTool } from '../src/tools/readFile.js'
import { editFileTool } from '../src/tools/editFile.js'
import { multiEditTool } from '../src/tools/multiEdit.js'
import { writeFileTool } from '../src/tools/writeFile.js'
import { deleteFileTool } from '../src/tools/deleteFile.js'

function context(cwd: string) {
  return { cwd, sessionId: 's1', readFiles: new Set<string>() }
}

test('grep finds matching lines', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-tools-'))
  try {
    await writeFile(path.join(dir, 'a.txt'), 'hello\nworld\n', 'utf8')
    const result = await grepTool.execute({ pattern: 'hello', glob: '**/*.txt' }, context(dir))
    assert.equal(result.ok, true)
    assert.match(result.content, /a.txt:1/)
    assert.equal(result.metadata?.display?.summary, 'Found 1 match across 1 file')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('grep headLimit caps total matches across files', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-tools-'))
  try {
    await writeFile(path.join(dir, 'a.txt'), 'hit a1\nhit a2\nhit a3\n', 'utf8')
    await writeFile(path.join(dir, 'b.txt'), 'hit b1\nhit b2\nhit b3\n', 'utf8')

    const result = await grepTool.execute({ pattern: 'hit', glob: '**/*.txt', headLimit: 4 }, context(dir))

    assert.equal(result.ok, true)
    assert.equal(result.content.split('\n').length, 4)
    assert.equal(result.metadata?.display?.summary, 'Found 4 matches across 2 files')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('read and glob tools return structured TUI summaries', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-tools-'))
  try {
    await writeFile(path.join(dir, 'a.txt'), 'one\ntwo\nthree\n', 'utf8')
    await writeFile(path.join(dir, 'b.txt'), 'other\n', 'utf8')

    const readResult = await readFileTool.execute({ filePath: 'a.txt' }, context(dir))
    assert.equal(readResult.ok, true)
    assert.equal(readResult.metadata?.display?.summary, 'Read 3 lines')

    const globResult = await getBuiltinTools()
      .find((tool) => tool.name === 'Glob')!
      .execute({ pattern: '*.txt' }, context(dir))
    assert.equal(globResult.ok, true)
    assert.equal(globResult.metadata?.display?.summary, 'Found 2 files')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('bash reports nonzero exits as command_failed', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-tools-'))
  try {
    const result = await bashTool.execute({ command: 'exit 7' }, context(dir))
    assert.equal(result.ok, false)
    assert.equal(result.errorCode, 'command_failed')
    assert.deepEqual((result.errorDetails as { exitCode?: number }).exitCode, 7)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('bash reports timeout explicitly', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-tools-'))
  try {
    const result = await bashTool.execute({
      command: 'node -e "setTimeout(() => {}, 1000)"',
      timeout: 50,
    }, context(dir))
    assert.equal(result.ok, false)
    assert.equal(result.errorCode, 'timeout')
    assert.deepEqual((result.errorDetails as { timeoutMs?: number }).timeoutMs, 50)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('editFile refuses editing before readFile', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-tools-'))
  try {
    await writeFile(path.join(dir, 'a.txt'), 'hello\n', 'utf8')
    const result = await editFileTool.execute({ filePath: 'a.txt', oldString: 'hello', newString: 'hi' }, context(dir))
    assert.equal(result.ok, false)
    assert.match(result.content, /must be read first/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('editFile edits after readFile', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-tools-'))
  try {
    const ctx = context(dir)
    await writeFile(path.join(dir, 'a.txt'), 'hello\n', 'utf8')
    await readFileTool.execute({ filePath: 'a.txt' }, ctx)
    const result = await editFileTool.execute({ filePath: 'a.txt', oldString: 'hello', newString: 'hi' }, ctx)
    assert.equal(result.ok, true)
    assert.equal(await readFile(path.join(dir, 'a.txt'), 'utf8'), 'hi\n')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('editFile treats dollar sequences in replacement as literal text', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-tools-'))
  try {
    const ctx = context(dir)
    const file = path.join(dir, 'a.txt')
    await writeFile(file, 'let total = a + b;\n', 'utf8')
    await readFileTool.execute({ filePath: 'a.txt' }, ctx)

    const result = await editFileTool.execute({
      filePath: 'a.txt',
      oldString: 'a + b',
      newString: 'price$1 + tax$$ + $&',
    }, ctx)

    assert.equal(result.ok, true)
    assert.equal(await readFile(file, 'utf8'), 'let total = price$1 + tax$$ + $&;\n')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('editFile reports nearby context when oldString matches multiple times', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-tools-'))
  try {
    const ctx = context(dir)
    await writeFile(path.join(dir, 'a.txt'), [
      'one',
      'target',
      'two',
      'three',
      'target',
      'four',
    ].join('\n'), 'utf8')
    await readFileTool.execute({ filePath: 'a.txt' }, ctx)

    const result = await editFileTool.execute({ filePath: 'a.txt', oldString: 'target', newString: 'done' }, ctx)

    assert.equal(result.ok, false)
    assert.equal(result.errorCode, 'precondition_failed')
    assert.match(result.content, /Expected exactly one match for oldString, found 2\./)
    assert.match(result.content, /Match 1 at line 2, column 1:/)
    assert.match(result.content, /> 2 \| target/)
    assert.match(result.content, /Match 2 at line 5, column 1:/)
    assert.equal((result.errorDetails as { occurrences?: number }).occurrences, 2)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('editFile truncates oldString match context after five matches', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-tools-'))
  try {
    const ctx = context(dir)
    await writeFile(path.join(dir, 'a.txt'), 'x\nx\nx\nx\nx\nx\n', 'utf8')
    await readFileTool.execute({ filePath: 'a.txt' }, ctx)

    const result = await editFileTool.execute({ filePath: 'a.txt', oldString: 'x', newString: 'y' }, ctx)

    assert.equal(result.ok, false)
    assert.match(result.content, /Showing first 5 of 6 matches\./)
    assert.equal((result.errorDetails as { truncated?: boolean }).truncated, true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('multiEdit applies multiple replacements atomically', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-tools-'))
  try {
    const ctx = { ...context(dir), readFileState: new Map<string, ReadFileState>() }
    const file = path.join(dir, 'a.txt')
    await writeFile(file, 'alpha\nbeta\ngamma\n', 'utf8')
    await readFileTool.execute({ filePath: 'a.txt' }, ctx)

    const result = await multiEditTool.execute({
      filePath: 'a.txt',
      edits: [
        { oldString: 'alpha', newString: 'ALPHA' },
        { oldString: 'gamma', newString: 'GAMMA' },
      ],
    }, ctx)

    assert.equal(result.ok, true)
    assert.equal(result.metadata?.display?.summary, 'Applied 2 edits to a.txt')
    assert.equal(await readFile(file, 'utf8'), 'ALPHA\nbeta\nGAMMA\n')
    assert.equal(ctx.readFileState.get(file)?.content, 'ALPHA\nbeta\nGAMMA\n')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('multiEdit treats dollar sequences in replacements as literal text', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-tools-'))
  try {
    const ctx = context(dir)
    const file = path.join(dir, 'a.txt')
    await writeFile(file, 'first = value\nsecond = value\n', 'utf8')
    await readFileTool.execute({ filePath: 'a.txt' }, ctx)

    const result = await multiEditTool.execute({
      filePath: 'a.txt',
      edits: [
        { oldString: 'first = value', newString: 'first = price$1 + tax$$ + $&' },
        { oldString: 'second = value', newString: "second = ${value} + $` + $'" },
      ],
    }, ctx)

    assert.equal(result.ok, true)
    assert.equal(await readFile(file, 'utf8'), "first = price$1 + tax$$ + $&\nsecond = ${value} + $` + $'\n")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('multiEdit does not write when any replacement is ambiguous', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-tools-'))
  try {
    const ctx = context(dir)
    const file = path.join(dir, 'a.txt')
    await writeFile(file, 'alpha\nbeta\nbeta\n', 'utf8')
    await readFileTool.execute({ filePath: 'a.txt' }, ctx)

    const result = await multiEditTool.execute({
      filePath: 'a.txt',
      edits: [
        { oldString: 'alpha', newString: 'ALPHA' },
        { oldString: 'beta', newString: 'BETA' },
      ],
    }, ctx)

    assert.equal(result.ok, false)
    assert.match(result.content, /Expected exactly one match for edits\[1\]\.oldString, found 2\./)
    assert.equal(await readFile(file, 'utf8'), 'alpha\nbeta\nbeta\n')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('readFile tracks content for post-compact restoration', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-tools-'))
  try {
    const ctx = { ...context(dir), readFileState: new Map<string, ReadFileState>() }
    const file = path.join(dir, 'a.txt')
    await writeFile(file, 'hello\n', 'utf8')
    const result = await readFileTool.execute({ filePath: 'a.txt' }, ctx)

    assert.equal(result.ok, true)
    assert.equal(ctx.readFileState.get(file)?.content, 'hello\n')
    assert.equal(typeof ctx.readFileState.get(file)?.timestamp, 'number')
    assert.equal(typeof ctx.readFileState.get(file)?.mtimeMs, 'number')
    assert.equal(ctx.readFileState.get(file)?.size, 6)
    assert.equal(typeof ctx.readFileState.get(file)?.ctimeMs, 'number')
    assert.equal(typeof ctx.readFileState.get(file)?.dev, 'number')
    assert.equal(typeof ctx.readFileState.get(file)?.ino, 'number')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('readFile evicts read tracking and read state together', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-tools-'))
  try {
    const ctx = { ...context(dir), readFileState: new Map<string, ReadFileState>() }
    const firstFile = path.join(dir, 'first.txt')
    await writeFile(firstFile, 'first\n', 'utf8')
    await readFileTool.execute({ filePath: 'first.txt' }, ctx)

    for (let index = 0; index < 100; index += 1) {
      const fileName = `file-${index}.txt`
      await writeFile(path.join(dir, fileName), `${index}\n`, 'utf8')
      await readFileTool.execute({ filePath: fileName }, ctx)
    }

    assert.equal(ctx.readFileState.has(firstFile), false)
    assert.equal(ctx.readFiles.has(firstFile), false)
    assert.equal(ctx.readFileState.size, 100)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('editFile reports missing read state separately from unread files', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-tools-'))
  try {
    const ctx = { ...context(dir), readFileState: new Map<string, ReadFileState>() }
    const file = path.join(dir, 'a.txt')
    await writeFile(file, 'hello\n', 'utf8')
    ctx.readFiles.add(file)

    const result = await editFileTool.execute({ filePath: 'a.txt', oldString: 'hello', newString: 'hi' }, ctx)

    assert.equal(result.ok, false)
    assert.equal(result.errorCode, 'precondition_failed')
    assert.match(result.content, /read state is no longer available/)
    assert.equal((result.errorDetails as { reason?: string }).reason, 'read_state_missing')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('readFile refreshes recency timestamp on repeated reads', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-tools-'))
  try {
    const ctx = { ...context(dir), readFileState: new Map<string, ReadFileState>() }
    const file = path.join(dir, 'a.txt')
    await writeFile(file, 'hello\n', 'utf8')
    await readFileTool.execute({ filePath: 'a.txt' }, ctx)
    const firstTimestamp = ctx.readFileState.get(file)?.timestamp ?? 0

    await readFileTool.execute({ filePath: 'a.txt' }, ctx)
    const secondTimestamp = ctx.readFileState.get(file)?.timestamp ?? 0

    assert.ok(secondTimestamp > firstTimestamp)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('editFile refuses files replaced after read even when size matches', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-tools-'))
  try {
    const ctx = { ...context(dir), readFileState: new Map<string, ReadFileState>() }
    const file = path.join(dir, 'a.txt')
    const replacement = path.join(dir, 'replacement.txt')
    await writeFile(file, 'alpha\n', 'utf8')
    await readFileTool.execute({ filePath: 'a.txt' }, ctx)
    await writeFile(replacement, 'bravo\n', 'utf8')
    await rename(replacement, file)

    const stale = await editFileTool.execute({ filePath: 'a.txt', oldString: 'bravo', newString: 'charl' }, ctx)
    assert.equal(stale.ok, false)
    assert.equal(stale.errorCode, 'stale_file')
    assert.match(stale.content, /changed since it was last read/)
    assert.equal((stale.errorDetails as { current?: { size?: number } }).current?.size, 6)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('editFile refuses stale files until they are read again', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-tools-'))
  try {
    const ctx = { ...context(dir), readFileState: new Map<string, ReadFileState>() }
    const file = path.join(dir, 'a.txt')
    await writeFile(file, 'hello\n', 'utf8')
    await readFileTool.execute({ filePath: 'a.txt' }, ctx)
    await writeFile(file, 'hello world\n', 'utf8')

    const stale = await editFileTool.execute({ filePath: 'a.txt', oldString: 'world', newString: 'there' }, ctx)
    assert.equal(stale.ok, false)
    assert.equal(stale.errorCode, 'stale_file')
    assert.match(stale.content, /changed since it was last read/)

    await readFileTool.execute({ filePath: 'a.txt' }, ctx)
    const result = await editFileTool.execute({ filePath: 'a.txt', oldString: 'world', newString: 'there' }, ctx)
    assert.equal(result.ok, true)
    assert.equal(result.metadata?.display?.summary, 'Edited a.txt')
    assert.equal(await readFile(file, 'utf8'), 'hello there\n')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('writeFile creates parent directories', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-tools-'))
  try {
    const result = await writeFileTool.execute({ filePath: 'nested/a.txt', content: 'hello' }, context(dir))
    assert.equal(result.ok, true)
    assert.equal(result.metadata?.display?.summary, 'Created nested/a.txt')
    assert.equal(await readFile(path.join(dir, 'nested', 'a.txt'), 'utf8'), 'hello')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('writeFile refuses new file when parent has a case-insensitive name collision', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-tools-'))
  try {
    await writeFile(path.join(dir, 'Existing.txt'), 'hello', 'utf8')
    const result = await writeFileTool.execute({ filePath: 'existing.txt', content: 'updated' }, context(dir))
    assert.equal(result.ok, false)
    assert.equal(result.errorCode, 'precondition_failed')
    assert.match(result.content, /different casing/)
    assert.equal(await readFile(path.join(dir, 'Existing.txt'), 'utf8'), 'hello')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('writeFile refuses to overwrite unread existing files', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-tools-'))
  try {
    await writeFile(path.join(dir, 'a.txt'), 'hello', 'utf8')
    const result = await writeFileTool.execute({ filePath: 'a.txt', content: 'updated' }, context(dir))
    assert.equal(result.ok, false)
    assert.equal(result.errorCode, 'precondition_failed')
    assert.match(result.content, /must be read first/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('writeFile overwrites fresh reads and updates read state', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-tools-'))
  try {
    const ctx = { ...context(dir), readFileState: new Map<string, ReadFileState>() }
    const file = path.join(dir, 'a.txt')
    await writeFile(file, 'hello', 'utf8')
    await readFileTool.execute({ filePath: 'a.txt' }, ctx)

    const result = await writeFileTool.execute({ filePath: 'a.txt', content: 'updated' }, ctx)
    assert.equal(result.ok, true)
    assert.equal(result.metadata?.display?.summary, 'Overwrote a.txt')
    assert.equal(await readFile(file, 'utf8'), 'updated')
    assert.equal(ctx.readFileState.get(file)?.content, 'updated')
    assert.equal(ctx.readFileState.get(file)?.size, 7)
    assert.equal(ctx.readFileState.get(file)?.ino, (await stat(file)).ino)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('writeFile refuses to write through a symlink parent', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-tools-'))
  try {
    await mkdir(path.join(dir, 'real'))
    try {
      await symlink(path.join(dir, 'real'), path.join(dir, 'link'), process.platform === 'win32' ? 'junction' : 'dir')
    } catch (error) {
      t.skip(`Cannot create directory symlink: ${String(error)}`)
      return
    }

    const result = await writeFileTool.execute({ filePath: path.join('link', 'a.txt'), content: 'hello' }, context(dir))
    assert.equal(result.ok, false)
    assert.equal(result.errorCode, 'precondition_failed')
    assert.match(result.content, /ancestor directory is a symlink/)
    await assert.rejects(() => readFile(path.join(dir, 'real', 'a.txt'), 'utf8'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('editFile refuses to edit through a symlink parent', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-tools-'))
  try {
    const ctx = { ...context(dir), readFileState: new Map<string, ReadFileState>() }
    await mkdir(path.join(dir, 'real'))
    await writeFile(path.join(dir, 'real', 'a.txt'), 'hello', 'utf8')
    try {
      await symlink(path.join(dir, 'real'), path.join(dir, 'link'), process.platform === 'win32' ? 'junction' : 'dir')
    } catch (error) {
      t.skip(`Cannot create directory symlink: ${String(error)}`)
      return
    }
    await readFileTool.execute({ filePath: path.join('link', 'a.txt') }, ctx)

    const result = await editFileTool.execute({ filePath: path.join('link', 'a.txt'), oldString: 'hello', newString: 'bye' }, ctx)
    assert.equal(result.ok, false)
    assert.equal(result.errorCode, 'precondition_failed')
    assert.match(result.content, /ancestor directory is a symlink/)
    assert.equal(await readFile(path.join(dir, 'real', 'a.txt'), 'utf8'), 'hello')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('deleteFile removes files', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-tools-'))
  try {
    const ctx = { ...context(dir), readFileState: new Map<string, ReadFileState>() }
    const file = path.join(dir, 'a.txt')
    await writeFile(file, 'hello', 'utf8')
    await readFileTool.execute({ filePath: 'a.txt' }, ctx)
    const result = await deleteFileTool.execute({ filePath: 'a.txt' }, ctx)
    assert.equal(result.ok, true)
    assert.equal(result.metadata?.display?.summary, 'Deleted a.txt')
    assert.equal(ctx.readFiles.has(file), false)
    assert.equal(ctx.readFileState.has(file), false)
    await assert.rejects(() => readFile(file, 'utf8'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('deleteFile refuses unread files', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-tools-'))
  try {
    await writeFile(path.join(dir, 'a.txt'), 'hello', 'utf8')
    const result = await deleteFileTool.execute({ filePath: 'a.txt' }, context(dir))
    assert.equal(result.ok, false)
    assert.equal(result.errorCode, 'precondition_failed')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('deleteFile refuses to delete through a symlink parent', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-tools-'))
  try {
    const ctx = { ...context(dir), readFileState: new Map<string, ReadFileState>() }
    await mkdir(path.join(dir, 'real'))
    await writeFile(path.join(dir, 'real', 'a.txt'), 'hello', 'utf8')
    try {
      await symlink(path.join(dir, 'real'), path.join(dir, 'link'), process.platform === 'win32' ? 'junction' : 'dir')
    } catch (error) {
      t.skip(`Cannot create directory symlink: ${String(error)}`)
      return
    }
    await readFileTool.execute({ filePath: path.join('link', 'a.txt') }, ctx)

    const result = await deleteFileTool.execute({ filePath: path.join('link', 'a.txt') }, ctx)
    assert.equal(result.ok, false)
    assert.equal(result.errorCode, 'precondition_failed')
    assert.match(result.content, /ancestor directory is a symlink/)
    assert.equal(await readFile(path.join(dir, 'real', 'a.txt'), 'utf8'), 'hello')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
test('concurrency-safe builtin tools are read-only and write tools remain barriers', () => {
  const tools = getBuiltinTools()
  const byName = new Map(tools.map((tool) => [tool.name, tool]))

  for (const tool of tools) {
    if (tool.isConcurrencySafe) {
      assert.equal(tool.isReadOnly, true, `${tool.name} must be read-only to be concurrency safe`)
    }
  }

  for (const toolName of ['Write', 'Edit', 'MultiEdit', 'Delete']) {
    assert.notEqual(byName.get(toolName)?.isConcurrencySafe, true, `${toolName} must be a write barrier`)
  }
})
