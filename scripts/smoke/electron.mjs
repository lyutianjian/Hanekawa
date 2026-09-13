/** Isolate the smoke window's single-instance lock and Chromium preferences. */
import { app } from 'electron'
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const profile = process.argv.find((arg) => arg.startsWith('--smoke-profile='))?.slice('--smoke-profile='.length)
if (!profile) throw new Error('The smoke launcher requires --smoke-profile=<directory>')
mkdirSync(profile, { recursive: true })
app.setPath('userData', profile)
app.setPath('sessionData', profile)
app.setName('myagent')
app.setAppPath(fileURLToPath(new URL('../..', import.meta.url)))

// Closing the final macOS window intentionally leaves the app running. The
// driver sends this signal to its own child to exercise the real before-quit
// teardown instead of mistaking Page.close for Quit and eventually killing it.
process.once('SIGTERM', () => app.quit())

// The shipped entry point still owns all window/runtime bootstrap and teardown.
await import('../../dist/desktop/main.js')
