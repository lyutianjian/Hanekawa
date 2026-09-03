import test from 'node:test'
import assert from 'node:assert/strict'
import { _resetCachedShellForTests, describeShell } from '../src/tools/bash.js'

/**
 * The name the prompt's `# Environment` block gives the shell.
 *
 * It used to be derived there — `process.env.SHELL ?? (win32 ? 'powershell' :
 * 'bash')` — while the `Bash` tool itself prefers Git for Windows' `bash.exe`
 * and only falls back to PowerShell when no bash exists. The model was told
 * `powershell` and wrote `NUL`, `%VAR%` and backslash paths into a POSIX shell.
 *
 * `SHELL` is honoured on every platform (on Windows it is the first thing
 * `detectShell` consults after the explicit override), so these cases drive the
 * same detection the tool does without depending on the host's filesystem. The
 * platform is a parameter for the same reason: what the label has to say differs
 * between the two, and neither branch may be reachable only on one developer's
 * machine.
 */

function withShell(value: string, run: () => void): void {
  const before = process.env.SHELL
  process.env.SHELL = value
  _resetCachedShellForTests()
  try {
    run()
  } finally {
    if (before === undefined) delete process.env.SHELL
    else process.env.SHELL = before
    _resetCachedShellForTests()
  }
}

test('on Windows the shell is named as the POSIX shell it is', () => {
  // Git for Windows exports `SHELL=/bin/bash.exe`, so the path itself cannot say
  // 「Git Bash」 — the platform pairing is what carries it. Without this the
  // `Platform: win32` line right above reads as "use Windows syntax".
  withShell('/bin/bash.exe', () => {
    assert.equal(describeShell('win32'), 'bash (POSIX shell on Windows)')
  })
  withShell('C:/Program Files/Git/bin/bash.exe', () => {
    assert.equal(describeShell('win32'), 'bash (POSIX shell on Windows)')
  })
})

test('elsewhere the shell is named by its own binary, without path or extension', () => {
  withShell('/bin/bash', () => assert.equal(describeShell('linux'), 'bash'))
  withShell('/usr/bin/zsh', () => assert.equal(describeShell('darwin'), 'zsh'))
})

// The PowerShell fallback has no case here on purpose: `detectShell` ignores
// `SHELL=powershell` on Windows and goes looking for a bash anyway, so reaching
// that branch means a host with no bash installed — which is exactly the machine
// this suite does not get to choose. The label for it is a literal in one line.

test('the answer is cached, so the prompt pays one detection per process', () => {
  withShell('/bin/bash', () => {
    assert.equal(describeShell('linux'), 'bash')
    process.env.SHELL = '/usr/bin/zsh'
    assert.equal(describeShell('linux'), 'bash', 'the tool would spawn the shell it already resolved')
  })
})
