#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createTestEnvironment, killTestProcess, onTestExit } from './test-environment.mjs'

// Keep the normal Node test CLI, including focused files and reporter flags.
const args = process.argv.slice(2)
if (!args.some((arg) => !arg.startsWith('-') && /\.(?:[cm]?[jt]sx?)$/.test(arg))) {
  args.push('test/**/*.test.ts')
}
const environment = createTestEnvironment()
const child = spawn(process.execPath, ['--import', 'tsx', '--test', ...args], {
  cwd: fileURLToPath(new URL('..', import.meta.url)),
  env: environment.env,
  stdio: 'inherit',
  detached: process.platform !== 'win32',
})
const unregister = onTestExit(() => killTestProcess(child.pid))
child.on('error', (error) => console.error(error))
const code = await new Promise((resolve) => child.once('close', (code) => resolve(code ?? 1)))
unregister()
const failure = environment.cleanup()
if (failure) console.error(`Test cleanup failed: ${failure}`)
process.exitCode = failure ? 2 : code
