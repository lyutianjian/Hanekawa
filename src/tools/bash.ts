import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { z } from 'zod/v3'
import type { Tool, ToolResult } from '../harness/types.js'

interface BashInput {
  command: string
  timeout?: number
}

interface ShellInfo {
  shell: string
  args: (cmd: string) => string[]
}

function detectShell(): ShellInfo {
  if (process.platform !== 'win32') {
    return { shell: process.env.SHELL ?? 'bash', args: (cmd) => ['-c', cmd] }
  }

  // 0. Explicit override always wins on every platform.
  const overridePath = process.env.MYAGENT_BASH_PATH
  if (overridePath && existsSync(overridePath)) {
    return { shell: overridePath, args: (cmd) => ['-c', cmd] }
  }

  // Windows: prefer bash (Git for Windows / WSL) over PowerShell
  // 1. Check SHELL env var
  const envShell = process.env.SHELL
  if (envShell && envShell !== 'powershell' && envShell !== 'cmd') {
    return { shell: envShell, args: (cmd) => ['-c', cmd] }
  }

  // 2. Check common Git for Windows bash location
  const gitBashPaths = [
    'C:/Program Files/Git/bin/bash.exe',
    'C:/Program Files (x86)/Git/bin/bash.exe',
    `${process.env.ProgramFiles ?? ''}/Git/bin/bash.exe`,
    `${process.env['ProgramFiles(x86)'] ?? ''}/Git/bin/bash.exe`,
  ]
  for (const p of gitBashPaths) {
    if (p && existsSync(p)) {
      return { shell: p, args: (cmd) => ['-c', cmd] }
    }
  }

  // 3. Check if bash is on PATH. spawnSync can block the event loop, but we
  //    only ever run this lazily on the first bash tool execution, never at
  //    module load, so it cannot stall TUI startup.
  try {
    const result = spawnSync('bash', ['--version'], { timeout: 3000, stdio: 'pipe' })
    if (result.status === 0) {
      return { shell: 'bash', args: (cmd) => ['-c', cmd] }
    }
  } catch { /* bash not available */ }

  // 4. Fall back to PowerShell
  return { shell: 'powershell', args: (cmd) => ['-Command', cmd] }
}

// Lazily resolved shell info. Detection is deferred until the first bash
// tool execution so we never run synchronous probes (existsSync chain or
// spawnSync) during module load and block TUI startup.
let cachedShell: ShellInfo | undefined

function getShell(): ShellInfo {
  if (!cachedShell) {
    cachedShell = detectShell()
  }
  return cachedShell
}

// Test-only hook: lets tests reset the cache between runs without leaking
// detection state across cases. Not part of the public Tool surface.
export function _resetCachedShellForTests(): void {
  cachedShell = undefined
}

export const bashTool: Tool = {
  name: 'bash',
  description: 'Execute a shell command and return its output.',
  inputSchema: z.object({
    command: z.string().min(1),
    timeout: z.number().min(1).max(600_000).optional(),
  }).strict(),
  riskLevel: 'dangerous',
  isDestructive: true,
  maxResultSizeChars: 100_000,
  async execute(input, context) {
    const options = input as BashInput
    const timeout = options.timeout ?? 30_000

    return new Promise<ToolResult>((resolve) => {
      const { shell, args: shellArgs } = getShell()

      const proc = spawn(shell, shellArgs(options.command), {
        cwd: context.cwd,
        signal: context.abortSignal,
      })

      const MAX_OUTPUT_BYTES = 1_000_000
      let stdout = ''
      let stderr = ''
      let truncated = false
      let timedOut = false

      const timeoutId = setTimeout(() => {
        timedOut = true
        proc.kill()
      }, timeout)

      const finish = (result: ToolResult) => {
        clearTimeout(timeoutId)
        resolve(result)
      }

      proc.stdout.on('data', (data: Buffer) => {
        if (stdout.length < MAX_OUTPUT_BYTES) {
          stdout += data.toString()
          if (stdout.length > MAX_OUTPUT_BYTES) {
            stdout = stdout.slice(0, MAX_OUTPUT_BYTES)
            truncated = true
          }
        }
      })

      proc.stderr.on('data', (data: Buffer) => {
        if (stderr.length < MAX_OUTPUT_BYTES) {
          stderr += data.toString()
          if (stderr.length > MAX_OUTPUT_BYTES) {
            stderr = stderr.slice(0, MAX_OUTPUT_BYTES)
            truncated = true
          }
        }
      })

      proc.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
        const output = [stdout, stderr].filter(Boolean).join('\n')
        const suffix = truncated ? '\n\n[Output truncated: exceeded 1MB limit]' : ''
        const content = (output || '(no output)') + suffix

        if (timedOut) {
          finish({
            ok: false,
            content,
            errorCode: 'timeout',
            errorDetails: { timeoutMs: timeout, signal },
          })
          return
        }

        if (code !== 0) {
          finish({
            ok: false,
            content,
            errorCode: 'command_failed',
            errorDetails: { exitCode: code, signal },
          })
          return
        }

        finish({ ok: true, content })
      })

      proc.on('error', (err: Error) => {
        if (err.name === 'AbortError') {
          finish({ ok: false, content: 'Operation cancelled by user', errorCode: 'aborted' })
        } else {
          const output = [stdout, stderr, err.message].filter(Boolean).join('\n')
          finish({ ok: false, content: output || 'Command failed.', errorCode: 'execution_failed' })
        }
      })
    })
  },
}
