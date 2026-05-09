import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import { grepTool } from '../src/tools/grep.js'
import { readFileTool } from '../src/tools/readFile.js'
import { editFileTool } from '../src/tools/editFile.js'
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

test('writeFile creates parent directories', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-tools-'))
  try {
    const result = await writeFileTool.execute({ filePath: 'nested/a.txt', content: 'hello' }, context(dir))
    assert.equal(result.ok, true)
    assert.equal(await readFile(path.join(dir, 'nested', 'a.txt'), 'utf8'), 'hello')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('deleteFile removes files', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-tools-'))
  try {
    const file = path.join(dir, 'a.txt')
    await writeFile(file, 'hello', 'utf8')
    const result = await deleteFileTool.execute({ filePath: 'a.txt' }, context(dir))
    assert.equal(result.ok, true)
    await assert.rejects(() => readFile(file, 'utf8'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
