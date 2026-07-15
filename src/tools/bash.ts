import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { Buffer } from 'node:buffer'
import { z } from 'zod/v3'
import type { Tool, ToolResult } from '../harness/types.js'
import {
  BackgroundTaskRegistry,
  defaultBackgroundTaskRegistry,
} from '../services/backgroundTasks/registry.js'
import { terminateProcessTree } from '../services/backgroundTasks/processTree.js'

interface BashInput {
  command: string
  timeout?: number
  run_in_background?: boolean
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

/**
 * Minimum sleep duration (seconds) that triggers the blocked-sleep pattern.
 * Sleep commands below this threshold are allowed without run_in_background.
 */
const SLEEP_BLOCK_THRESHOLD_SECONDS = 2

/**
 * Detect a standalone blocking sleep pattern at the start of a command.
 * Returns the sleep duration in seconds if found, or null otherwise.
 *
 * Matches:
 *   - `sleep N` (standalone)
 *   - `sleep N && ...` (sleep as the first command in a chain)
 *   - `sleep N || ...` (sleep as the first command in an OR chain)
 *   - `sleep N; ...` (sleep followed by semicolon)
 *   - `sleep N | ...` (sleep as the first command in a pipe)
 *   - `sleep N # comment` (sleep with shell comment)
 *
 * Does NOT match:
 *   - `sleep 0.5` (below threshold)
 *   - `for i in 1 2; do sleep 1; done` (sleep inside compound command)
 *   - `echo hello && sleep 5` (sleep not at the start)
 */
export function detectSleepPattern(command: string): number | null {
  const trimmed = command.trim()
  // Match: "sleep", whitespace, number (int or float),
  // then end-of-string or whitespace followed by shell operators (&&, ||, ;, |) or comment (#)
  const match = trimmed.match(/^sleep\s+(\d+(?:\.\d+)?)\s*(?:$|&&|\|\||[;|#])/)
  if (!match) return null

  const seconds = parseFloat(match[1]!)
  if (isNaN(seconds) || seconds < SLEEP_BLOCK_THRESHOLD_SECONDS) return null
  return seconds
}

export function createBashTool(backgroundTasks: BackgroundTaskRegistry = defaultBackgroundTaskRegistry): Tool {
  return {
  name: 'Bash',
  description: 'Execute a shell command and return its output. Set run_in_background: true for long-running commands (e.g. sleep, servers).',
  searchHint: 'run shell commands terminal',
  inputSchema: z.object({
    command: z.string().min(1),
    timeout: z.number().min(1).max(600_000).optional(),
    run_in_background: z.boolean().optional(),
  }).strict(),
  riskLevel: 'dangerous',
  isDestructive: true,
  maxResultSizeChars: 100_000,
  userFacingName: () => 'Bash',
  getToolUseSummary(input) {
    const command = typeof input === 'object' && input !== null
      ? (input as { command?: unknown }).command
      : undefined
    return typeof command === 'string' ? summarizeCommand(command) : null
  },
  getActivityDescription(input) {
    const command = typeof input === 'object' && input !== null
      ? (input as { command?: unknown }).command
      : undefined
    return typeof command === 'string' ? `Running ${summarizeCommand(command)}` : 'Running command'
  },
  shouldDisplayResult: () => true,
  async execute(input, context) {
    const options = input as BashInput
    const timeout = options.timeout ?? 30_000

    // Block standalone sleep commands unless run_in_background is set.
    const sleepSeconds = detectSleepPattern(options.command)
    if (sleepSeconds !== null && !options.run_in_background) {
      return {
        ok: false,
        content: `Blocking sleep command (${sleepSeconds}s) detected. Use \`run_in_background: true\` for long-running commands, or restructure to avoid blocking the conversation.`,
        errorCode: 'precondition_failed',
        errorDetails: { sleepSeconds },
      }
    }

    const { shell, args: shellArgs } = getShell()

    if (options.run_in_background) {
      const proc = spawn(shell, shellArgs(options.command), {
        cwd: context.cwd,
        detached: process.platform !== 'win32',
      })
      const task = backgroundTasks.registerShell({
        sessionId: context.sessionId,
        command: options.command,
        proc,
      })
      let timeoutId: ReturnType<typeof setTimeout> | undefined
      if (options.timeout !== undefined) {
        timeoutId = setTimeout(() => {
          void backgroundTasks.killShell(
            context.sessionId,
            task.id,
            `Command timed out after ${options.timeout}ms`,
            true,
          )
        }, options.timeout)
      }
      proc.stdout?.on('data', (data: Buffer) => backgroundTasks.appendOutput(context.sessionId, task.id, data))
      proc.stderr?.on('data', (data: Buffer) => backgroundTasks.appendOutput(context.sessionId, task.id, data))
      proc.once('close', (code: number | null, signal: NodeJS.Signals | null) => {
        if (timeoutId) clearTimeout(timeoutId)
        backgroundTasks.finishShell(context.sessionId, task.id, code, signal)
      })
      proc.once('error', (error: Error) => {
        if (timeoutId) clearTimeout(timeoutId)
        backgroundTasks.fail(context.sessionId, task.id, error.message)
      })
      return {
        ok: true,
        content: [
          'Shell started in background.',
          `Task ID: ${task.id}`,
          ...(task.pid ? [`PID: ${task.pid}`] : []),
          `Use BashOutput with task_id \"${task.id}\" to read output or KillShell to stop it.`,
        ].join('\n'),
        metadata: {
          display: {
            summary: `background shell ${task.id} started`,
            detail: task.pid ? `PID: ${task.pid}` : undefined,
          },
        },
      }
    }

    return new Promise<ToolResult>((resolve) => {

      const proc = spawn(shell, shellArgs(options.command), {
        cwd: context.cwd,
        signal: context.abortSignal,
        // detached: true creates a new process group so we can kill all
        // child processes on timeout, not just the direct child.
        detached: process.platform !== 'win32',
      })

      const MAX_OUTPUT_BYTES = 1_000_000
      const stdoutChunks: Buffer[] = []
      const stderrChunks: Buffer[] = []
      let stdoutBytes = 0
      let stderrBytes = 0
      let truncated = false
      let timedOut = false

      const timeoutId = setTimeout(() => {
        timedOut = true
        void terminateProcessTree(proc)
      }, timeout)

      const finish = (result: ToolResult) => {
        clearTimeout(timeoutId)
        resolve(result)
      }

      proc.stdout.on('data', (data: Buffer) => {
        if (stdoutBytes < MAX_OUTPUT_BYTES) {
          stdoutChunks.push(data)
          stdoutBytes += data.length
          if (stdoutBytes > MAX_OUTPUT_BYTES) {
            truncated = true
          }
        }
      })

      proc.stderr.on('data', (data: Buffer) => {
        if (stderrBytes < MAX_OUTPUT_BYTES) {
          stderrChunks.push(data)
          stderrBytes += data.length
          if (stderrBytes > MAX_OUTPUT_BYTES) {
            truncated = true
          }
        }
      })

      proc.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
        // Decode accumulated Buffer chunks as UTF-8 in one shot to avoid
        // multi-byte character corruption at chunk boundaries.
        const stdout = Buffer.concat(stdoutChunks).toString('utf8')
        const stderr = Buffer.concat(stderrChunks).toString('utf8')
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
          const stdoutStr = Buffer.concat(stdoutChunks).toString('utf8')
          const stderrStr = Buffer.concat(stderrChunks).toString('utf8')
          const output = [stdoutStr, stderrStr, err.message].filter(Boolean).join('\n')
          finish({ ok: false, content: output || 'Command failed.', errorCode: 'execution_failed' })
        }
      })
    })
  },
  }
}

export const bashTool: Tool = createBashTool()

function summarizeCommand(command: string): string {
  const trimmed = command.trim()
  const lines = trimmed.split(/\r?\n/)
  const visible = lines.slice(0, 2).join('\n')
  const suffix = lines.length > 2 ? '...' : ''
  return truncateMiddle(`${visible}${suffix}`, 120)
}

function truncateMiddle(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value
  const keep = Math.max(1, Math.floor((maxLength - 3) / 2))
  return `${value.slice(0, keep)}...${value.slice(value.length - keep)}`
}
