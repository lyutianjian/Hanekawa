import { describe, it } from 'node:test'
import assert from 'node:assert'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

const CLI_PATH = join(import.meta.dirname, '..', 'src', 'entrypoints', 'cli.ts')

function runCli(args: string[]): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync(process.execPath, ['--import', 'tsx', CLI_PATH, ...args], {
    encoding: 'utf-8',
    timeout: 10000,
  })
  return {
    stdout: (result.stdout ?? '').trim(),
    stderr: (result.stderr ?? '').trim(),
    status: result.status,
  }
}

describe('CLI entrypoint', () => {
  it('prints help by default', () => {
    const { stdout, status } = runCli([])
    assert.equal(status, 0)
    assert(stdout.includes('MyAgent CLI'))
    assert(stdout.includes('Commands:'))
    assert(stdout.includes('help'))
  })

  it('prints help with help command', () => {
    const { stdout, status } = runCli(['help'])
    assert.equal(status, 0)
    assert(stdout.includes('During a session:'))
    assert(stdout.includes('Ctrl+Enter'))
    assert(stdout.includes('Ctrl+C'))
    assert(stdout.includes('Escape'))
    assert(stdout.includes('Ctrl+L'))
    assert(stdout.includes('Tab'))
  })

  it('lists sessions with list command', () => {
    const { stdout, stderr, status } = runCli(['list'])
    assert.equal(status, 0)
    assert(stdout.includes('No sessions found.') || stdout.includes('Sessions:'))
  })

  it('errors with unknown command', () => {
    const { stderr, status } = runCli(['unknown-command'])
    assert.notEqual(status, 0)
    assert(stderr.includes('Unknown command'))
  })

  it('errors when resume is missing session id', () => {
    const { stderr, status } = runCli(['resume'])
    assert.notEqual(status, 0)
    assert(stderr.includes('Usage:'))
  })
})
