import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { Buffer } from 'node:buffer'
import { z } from 'zod/v3'
import type { Tool, ToolResult } from '../harness/types.js'
import {
  BackgroundTaskRegistry,
  defaultBackgroundTaskRegistry,
  type BackgroundTaskSnapshot,
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

/** Align with Claude Code defaults (2 min / 10 min). */
export const DEFAULT_BASH_TIMEOUT_MS = 120_000
export const MAX_BASH_TIMEOUT_MS = 600_000

function parsePositiveInt(value: string | undefined): number | undefined {
  if (!value) return undefined
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

/**
 * Resolve the effective foreground timeout.
 * - explicit tool input wins (clamped to max)
 * - else MYAGENT_BASH_DEFAULT_TIMEOUT_MS / BASH_DEFAULT_TIMEOUT_MS
 * - else 120s
 * Max from MYAGENT_BASH_MAX_TIMEOUT_MS / BASH_MAX_TIMEOUT_MS (at least default), capped schema max 600s.
 */
export function resolveBashTimeoutMs(requested?: number, env: NodeJS.ProcessEnv = process.env): number {
  const envDefault =
    parsePositiveInt(env.MYAGENT_BASH_DEFAULT_TIMEOUT_MS)
    ?? parsePositiveInt(env.BASH_DEFAULT_TIMEOUT_MS)
  const envMax =
    parsePositiveInt(env.MYAGENT_BASH_MAX_TIMEOUT_MS)
    ?? parsePositiveInt(env.BASH_MAX_TIMEOUT_MS)

  const defaultMs = envDefault ?? DEFAULT_BASH_TIMEOUT_MS
  const maxMs = Math.min(
    MAX_BASH_TIMEOUT_MS,
    Math.max(defaultMs, envMax ?? MAX_BASH_TIMEOUT_MS),
  )
  const raw = requested ?? defaultMs
  return Math.min(Math.max(1, raw), maxMs)
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
 * The shell the `Bash` tool will actually use, named for the prompt's
 * `# Environment` block.
 *
 * The environment block used to derive its own answer (`process.env.SHELL ??
 * (win32 ? 'powershell' : 'bash')`) and on Windows that was simply false: the
 * tool prefers Git for Windows' `bash.exe` and only falls back to PowerShell
 * when no bash exists, so the model was told `powershell` and wrote `NUL`,
 * `%VAR%` and backslash paths into a POSIX shell. One detection, one answer.
 *
 * It runs `getShell()`, so the first prompt build pays the same lazy probe the
 * first tool call would have — never at module load.
 */
export function describeShell(platform: NodeJS.Platform = process.platform): string {
  const lower = getShell().shell.toLowerCase().replace(/\\/g, '/')
  if (lower.includes('powershell')) return 'powershell'
  if (lower.endsWith('cmd') || lower.endsWith('cmd.exe')) return 'cmd'
  const base = lower.split('/').pop() ?? lower
  const name = base.endsWith('.exe') ? base.slice(0, -4) : base
  // A POSIX shell on a Windows filesystem is the one combination worth spelling
  // out: the platform line right above this one says `win32`, and on its own
  // that reads as "use Windows syntax" — `NUL`, `%VAR%`, backslash paths. The
  // path is no help in saying so (Git Bash exports `SHELL=/bin/bash.exe`), so
  // the pairing is what names it.
  // Anything reaching here is spawned with `-c`, so it *is* a POSIX shell.
  if (platform === 'win32') return `${name} (POSIX shell on Windows)`
  return name
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

/**
 * Commands that should hard-timeout instead of auto-backgrounding.
 * Aligns with Claude Code: only bare leading `sleep` is excluded from auto-bg.
 * Explicit run_in_background still allowed for sleep via the pre-check path.
 */
export function isAutobackgroundingAllowed(command: string): boolean {
  const trimmed = command.trim()
  // First shell word is sleep (path-qualified ok: /bin/sleep)
  const first = trimmed.split(/[\s;|&]/)[0] ?? ''
  const base = first.replace(/\\/g, '/').split('/').pop()?.toLowerCase() ?? ''
  return base !== 'sleep'
}

function formatBackgroundStartMessage(
  task: BackgroundTaskSnapshot,
  kind: 'explicit' | 'timeout',
  timeoutMs?: number,
): string {
  const header =
    kind === 'timeout'
      ? `Command exceeded the blocking timeout (${timeoutMs}ms) and was moved to the background.`
      : 'Shell started in background.'
  return [
    header,
    `Task ID: ${task.id}`,
    ...(task.pid ? [`PID: ${task.pid}`] : []),
    `Use BashOutput with task_id \"${task.id}\" to read output or KillShell to stop it.`,
  ].join('\n')
}

function attachBackgroundLifecycle(options: {
  proc: ChildProcess
  backgroundTasks: BackgroundTaskRegistry
  sessionId: string
  taskId: string
  /** Optional hard-kill timeout for background shells (explicit BG only). */
  killAfterMs?: number
}): void {
  const { proc, backgroundTasks, sessionId, taskId, killAfterMs } = options
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  if (killAfterMs !== undefined) {
    timeoutId = setTimeout(() => {
      void backgroundTasks.killShell(
        sessionId,
        taskId,
        `Command timed out after ${killAfterMs}ms`,
        true,
      )
    }, killAfterMs)
  }

  const onData = (data: Buffer) => backgroundTasks.appendOutput(sessionId, taskId, data)
  proc.stdout?.on('data', onData)
  proc.stderr?.on('data', onData)

  // Use 'exit' not 'close': 'close' waits for stdio to close, which can
  // include grandchild processes that inherit file descriptors.
  proc.once('exit', (code: number | null, signal: NodeJS.Signals | null) => {
    if (timeoutId) clearTimeout(timeoutId)
    backgroundTasks.finishShell(sessionId, taskId, code, signal)
  })
  proc.once('error', (error: Error) => {
    if (timeoutId) clearTimeout(timeoutId)
    backgroundTasks.fail(sessionId, taskId, error.message)
  })
}

export function createBashTool(backgroundTasks: BackgroundTaskRegistry = defaultBackgroundTaskRegistry): Tool {
  return {
  name: 'Bash',
  description:
    'Execute a shell command and return its output. Default timeout 120s; on timeout the command is moved to the background (except sleep) so you can read it with BashOutput. Set run_in_background: true for servers/long jobs. Optional timeout in ms (max 600000).',
  searchHint: 'run shell commands terminal',
  inputSchema: z.object({
    command: z.string().min(1),
    timeout: z.number().min(1).max(MAX_BASH_TIMEOUT_MS).optional()
      .describe(`Optional timeout in milliseconds (default ${DEFAULT_BASH_TIMEOUT_MS}, max ${MAX_BASH_TIMEOUT_MS}). On timeout, non-sleep commands are moved to the background.`),
    run_in_background: z.boolean().optional()
      .describe('Set to true to run this command in the background immediately. Use BashOutput to read output later.'),
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
    const timeout = resolveBashTimeoutMs(options.timeout)

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
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      const task = backgroundTasks.registerShell({
        sessionId: context.sessionId,
        command: options.command,
        proc,
      })
      // Explicit BG: only install a kill timer when the caller set timeout.
      attachBackgroundLifecycle({
        proc,
        backgroundTasks,
        sessionId: context.sessionId,
        taskId: task.id,
        ...(options.timeout !== undefined ? { killAfterMs: resolveBashTimeoutMs(options.timeout) } : {}),
      })
      return {
        ok: true,
        content: formatBackgroundStartMessage(task, 'explicit'),
        metadata: {
          display: {
            summary: `background shell ${task.id} started`,
            detail: task.pid ? `PID: ${task.pid}` : undefined,
          },
        },
      }
    }

    return new Promise<ToolResult>((resolve) => {
      // Do not pass abortSignal to spawn: after timeout auto-background we must
      // keep the process alive when the tool call is aborted/settled. We handle
      // abort manually while still in foreground mode.
      const proc = spawn(shell, shellArgs(options.command), {
        cwd: context.cwd,
        // detached: true creates a new process group so we can kill all
        // child processes on timeout, not just the direct child.
        detached: process.platform !== 'win32',
        windowsHide: true,
        // Ignore stdin so interactive readers (cat/read/rg) do not hang waiting
        // for input that will never arrive.
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      const MAX_OUTPUT_BYTES = 1_000_000
      const stdoutChunks: Buffer[] = []
      const stderrChunks: Buffer[] = []
      let stdoutBytes = 0
      let stderrBytes = 0
      let truncated = false
      let timedOut = false
      let settled = false
      let mode: 'foreground' | 'backgrounded' = 'foreground'
      let timeoutId: ReturnType<typeof setTimeout> | undefined
      const autoBgAllowed = isAutobackgroundingAllowed(options.command)

      const buildOutput = (extra?: string): string => {
        // Decode accumulated Buffer chunks as UTF-8 in one shot to avoid
        // multi-byte character corruption at chunk boundaries.
        const stdout = Buffer.concat(stdoutChunks).toString('utf8')
        const stderr = Buffer.concat(stderrChunks).toString('utf8')
        const output = [stdout, stderr, extra].filter(Boolean).join('\n')
        const suffix = truncated ? '\n\n[Output truncated: exceeded 1MB limit]' : ''
        return (output || '(no output)') + suffix
      }

      const destroyStdio = () => {
        try { proc.stdout?.destroy() } catch { /* already closed */ }
        try { proc.stderr?.destroy() } catch { /* already closed */ }
      }

      const finish = (result: ToolResult, options?: { keepStdio?: boolean }) => {
        if (settled) return
        settled = true
        if (timeoutId !== undefined) clearTimeout(timeoutId)
        if (context.abortSignal) {
          context.abortSignal.removeEventListener('abort', onAbort)
        }
        if (!options?.keepStdio) destroyStdio()
        resolve(result)
      }

      const onAbort = () => {
        if (mode !== 'foreground' || settled) return
        void terminateProcessTree(proc).finally(() => {
          finish({
            ok: false,
            content: 'Operation cancelled by user',
            errorCode: 'aborted',
          })
        })
      }

      const onStdout = (data: Buffer) => {
        if (mode !== 'foreground') return
        if (stdoutBytes < MAX_OUTPUT_BYTES) {
          stdoutChunks.push(data)
          stdoutBytes += data.length
          if (stdoutBytes > MAX_OUTPUT_BYTES) truncated = true
        }
      }

      const onStderr = (data: Buffer) => {
        if (mode !== 'foreground') return
        if (stderrBytes < MAX_OUTPUT_BYTES) {
          stderrChunks.push(data)
          stderrBytes += data.length
          if (stderrBytes > MAX_OUTPUT_BYTES) truncated = true
        }
      }

      const promoteToBackground = (): void => {
        mode = 'backgrounded'
        // Stop foreground abort from killing the promoted process.
        if (context.abortSignal) {
          context.abortSignal.removeEventListener('abort', onAbort)
        }
        proc.stdout?.removeListener('data', onStdout)
        proc.stderr?.removeListener('data', onStderr)

        const task = backgroundTasks.registerShell({
          sessionId: context.sessionId,
          command: options.command,
          proc,
        })

        // Preserve output collected while foreground so BashOutput is not empty.
        if (stdoutChunks.length > 0) {
          backgroundTasks.appendOutput(context.sessionId, task.id, Buffer.concat(stdoutChunks))
        }
        if (stderrChunks.length > 0) {
          backgroundTasks.appendOutput(context.sessionId, task.id, Buffer.concat(stderrChunks))
        }

        // No kill timer on auto-bg — process may run until KillShell / session stop.
        attachBackgroundLifecycle({
          proc,
          backgroundTasks,
          sessionId: context.sessionId,
          taskId: task.id,
        })

        finish({
          ok: true,
          content: formatBackgroundStartMessage(task, 'timeout', timeout),
          metadata: {
            display: {
              summary: `background shell ${task.id} (timeout)`,
              detail: task.pid ? `PID: ${task.pid}` : undefined,
            },
          },
        }, { keepStdio: true })
      }

      timeoutId = setTimeout(() => {
        if (settled || mode !== 'foreground') return
        timedOut = true

        if (autoBgAllowed) {
          // Same process keeps running; only the tool call returns early.
          promoteToBackground()
          return
        }

        // Hard timeout (e.g. leading sleep that slipped past the pre-check).
        void terminateProcessTree(proc).finally(() => {
          finish({
            ok: false,
            content: buildOutput(),
            errorCode: 'timeout',
            errorDetails: { timeoutMs: timeout },
          })
        })
      }, timeout)

      if (context.abortSignal) {
        if (context.abortSignal.aborted) {
          onAbort()
        } else {
          context.abortSignal.addEventListener('abort', onAbort, { once: true })
        }
      }

      proc.stdout?.on('data', onStdout)
      proc.stderr?.on('data', onStderr)

      // Use 'exit' not 'close': 'close' waits for stdio to close, which includes
      // grandchild processes that inherit file descriptors (e.g. nested sleep).
      // 'exit' fires when the shell itself exits, returning control immediately.
      proc.once('exit', (code: number | null, signal: NodeJS.Signals | null) => {
        if (mode === 'backgrounded') {
          // Lifecycle is owned by the registry after promote.
          return
        }

        const content = buildOutput()

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

      proc.once('error', (err: Error) => {
        if (mode === 'backgrounded') return
        if (err.name === 'AbortError') {
          finish({ ok: false, content: 'Operation cancelled by user', errorCode: 'aborted' })
        } else {
          finish({
            ok: false,
            content: buildOutput(err.message),
            errorCode: 'execution_failed',
          })
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
