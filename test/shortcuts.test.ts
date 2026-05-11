import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { filePathCompleter, getHistoryPath, loadHistoryFile, appendHistoryLine, saveHistoryFile } from '../src/entrypoints/cli.js'

// ─── filePathCompleter ──────────────────────────────────────────────────

describe('filePathCompleter', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'myagent-completer-'))
    mkdirSync(join(tmpDir, 'subdir'))
    writeFileSync(join(tmpDir, 'file-a.txt'), '')
    writeFileSync(join(tmpDir, 'file-b.txt'), '')
    writeFileSync(join(tmpDir, 'other.log'), '')
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('completes file names by prefix', () => {
    const line = join(tmpDir, 'file')
    const [completions] = filePathCompleter(line)
    assert.equal(completions.length, 2)
    assert(completions.some((c) => c.endsWith('file-a.txt')))
    assert(completions.some((c) => c.endsWith('file-b.txt')))
  })

  it('completes directory names with trailing slash', () => {
    const line = join(tmpDir, 'sub')
    const [completions] = filePathCompleter(line)
    assert.equal(completions.length, 1)
    assert(completions[0].endsWith('/'))
  })

  it('returns empty for no matches', () => {
    const line = join(tmpDir, 'nonexistent')
    const [completions] = filePathCompleter(line)
    assert.equal(completions.length, 0)
  })

  it('shows all files in cwd for empty token', () => {
    // Change to temp directory so we can control the entries
    const originalCwd = process.cwd()
    try {
      process.chdir(tmpDir)
      // Empty token lists all entries in temp dir (subdir, file-a.txt, file-b.txt, other.log)
      const [completions] = filePathCompleter('')
      assert(completions.length >= 4)
    } finally {
      process.chdir(originalCwd)
    }
  })

  it('completes partial paths after a space (multi-word input)', () => {
    const line = 'some text ' + join(tmpDir, 'file')
    const [completions] = filePathCompleter(line)
    assert.equal(completions.length, 2)
  })

  it('handles nonexistent directory gracefully', () => {
    const line = '/nonexistent/path/file'
    const [completions] = filePathCompleter(line)
    assert.equal(completions.length, 0)
  })
})

// ─── History functions ──────────────────────────────────────────────────

describe('history functions', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'myagent-history-'))
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('getHistoryPath returns path under .myagent', () => {
    const path = getHistoryPath(tmpDir)
    assert(path.endsWith(join('.myagent', 'history')))
  })

  it('loadHistoryFile returns empty array when file does not exist', () => {
    const lines = loadHistoryFile(tmpDir)
    assert.deepStrictEqual(lines, [])
  })

  it('loadHistoryFile loads and filters lines', () => {
    appendHistoryLine('line 1', tmpDir)
    appendHistoryLine('line 2', tmpDir)
    appendHistoryLine('', tmpDir)

    const lines = loadHistoryFile(tmpDir)
    assert.deepStrictEqual(lines, ['line 1', 'line 2'])
  })

  it('appendHistoryLine creates directory and appends', () => {
    appendHistoryLine('hello', tmpDir)
    const path = getHistoryPath(tmpDir)
    assert(existsSync(path))
    const content = readFileSync(path, 'utf-8')
    assert(content.includes('hello'))
  })

  it('saveHistoryFile deduplicates lines', () => {
    saveHistoryFile(['a', 'b', 'a', 'a'], tmpDir)
    const lines = loadHistoryFile(tmpDir)
    assert.deepStrictEqual(lines, ['a', 'b'])
  })

  it('saveHistoryFile truncates to HISTORY_MAX', () => {
    const many = Array.from({ length: 2000 }, (_, i) => `line-${i}`)
    saveHistoryFile(many, tmpDir)
    const lines = loadHistoryFile(tmpDir)
    assert.equal(lines.length, 1000)
    // Should keep the most recent lines (last 1000)
    assert(lines[lines.length - 1] === 'line-1999')
  })

  it('saveHistoryFile handles empty array', () => {
    saveHistoryFile([], tmpDir)
    const path = getHistoryPath(tmpDir)
    assert(existsSync(path))
    const content = readFileSync(path, 'utf-8')
    assert.equal(content, '\n')
  })
})
