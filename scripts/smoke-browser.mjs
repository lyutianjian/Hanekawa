/**
 * Runs `scripts/smoke/browser.cjs` in Electron against a disposable profile.
 *
 * The profile is removed here, after the child has exited: Chromium flushes
 * its partition on the way out, so a cleanup inside the app races it. Run a
 * build first (`npm run smoke:browser` does).
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const electron = createRequire(import.meta.url)('electron')
const profile = mkdtempSync(join(tmpdir(), 'hanekawa-smoke-browser-'))

// Chromium refuses to run as root with its sandbox on; a container is the
// only place that happens, and nothing loaded here is untrusted.
const switches = process.platform === 'linux' && process.getuid?.() === 0 ? ['--no-sandbox'] : []
const child = spawn(electron, [...switches, join(repoRoot, 'scripts/smoke/browser.cjs'), `--smoke-profile=${profile}`], {
  cwd: repoRoot,
  stdio: 'inherit',
})
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal))

child.once('exit', (code) => {
  let cleanup = 0
  try {
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  } catch (error) {
    console.error(`could not remove the smoke profile ${profile}: ${error}`)
    cleanup = 1
  }
  // A child killed by a signal has no code; that is a failed run too.
  process.exit(code === 0 ? cleanup : 1)
})
