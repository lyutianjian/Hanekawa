import { spawn } from 'node:child_process'
import type { Tool, ToolContext } from './types.js'

const DEFAULT_HOOK_TIMEOUT_MS = 30_000
const MAX_HOOK_OUTPUT_BYTES = 200_000

export interface HookCommand {
  matcher?: string
  command: string
  timeoutMs?: number
}

export interface Hooks {
  userPromptSubmit?: HookCommand[]
  preToolUse?: HookCommand[]
  postToolUse?: HookCommand[]
  stop?: HookCommand[]
}

export type PreToolUseHook = HookCommand
export type ToolHooks = Hooks

export interface PreToolUseHookResult {
  ok: boolean
  content?: string
  details?: unknown
  stdout?: string
}

export interface LifecycleHookOutput {
  stdout: string
  failures: string[]
  blockingErrors: string[]
  preventContinuation: boolean
}

export async function runPreToolUseHooks(
  hooks: readonly HookCommand[] | undefined,
  tool: Tool,
  input: unknown,
  context: ToolContext,
  signal?: AbortSignal,
): Promise<PreToolUseHookResult> {
  if (!hooks || hooks.length === 0) return { ok: true }

  for (const hook of hooks) {
    if (!matchesHook(hook, tool.name)) continue
    const result = await runHookCommand({
      hook,
      hookName: 'preToolUse',
      context,
      signal,
      input: {
        tool: tool.name,
        riskLevel: tool.riskLevel,
        input,
        cwd: context.cwd,
        sessionId: context.sessionId,
      },
      failurePrefix: `Pre-tool hook failed for ${tool.name}`,
      timeoutPrefix: `Pre-tool hook timed out for ${tool.name}`,
      blockedPrefix: `Pre-tool hook blocked ${tool.name}`,
    })
    if (!result.ok) return result
  }

  return { ok: true }
}

export async function runLifecycleHooks(
  hooks: readonly HookCommand[] | undefined,
  hookName: 'userPromptSubmit' | 'stop',
  input: Record<string, unknown>,
  context: ToolContext,
  signal?: AbortSignal,
): Promise<LifecycleHookOutput> {
  if (!hooks || hooks.length === 0) {
    return { stdout: '', failures: [], blockingErrors: [], preventContinuation: false }
  }

  const outputs: string[] = []
  const failures: string[] = []
  const blockingErrors: string[] = []
  let preventContinuation = false
  for (const hook of hooks) {
    const result = await runHookCommand({
      hook,
      hookName,
      context,
      signal,
      input: {
        ...input,
        cwd: context.cwd,
        sessionId: context.sessionId,
      },
      failurePrefix: `${hookName} hook failed`,
      timeoutPrefix: `${hookName} hook timed out`,
      blockedPrefix: `${hookName} hook failed`,
    })

    const control = parseLifecycleHookControl(result.stdout ?? '', result.stderr ?? '')
    if (control.stdout.trim()) outputs.push(control.stdout.trim())
    blockingErrors.push(...control.blockingErrors)
    preventContinuation ||= control.preventContinuation

    if (result.ok) {
      continue
    } else {
      failures.push(result.content ?? `${hookName} hook failed: ${hook.command}`)
    }
  }

  return {
    stdout: outputs.join('\n\n'),
    failures,
    blockingErrors,
    preventContinuation,
  }
}

function matchesHook(hook: HookCommand, toolName: string): boolean {
  return !hook.matcher || matchGlob(toolName, hook.matcher)
}

function matchGlob(content: string, pattern: string): boolean {
  const regexPattern = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.')
  return new RegExp(`^${regexPattern}$`, 'i').test(content)
}

function runHookCommand(options: {
  hook: HookCommand
  hookName: string
  input: Record<string, unknown>
  context: ToolContext
  signal?: AbortSignal
  failurePrefix: string
  timeoutPrefix: string
  blockedPrefix: string
}): Promise<PreToolUseHookResult & { stdout?: string; stderr?: string }> {
  return new Promise((resolve) => {
    const { hook, hookName, input, context, signal, failurePrefix, timeoutPrefix, blockedPrefix } = options
    const timeoutMs = Math.max(1, hook.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS)
    const proc = spawn(hook.command, [], {
      cwd: context.cwd,
      shell: true,
      signal,
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    let settled = false
    let timedOut = false

    const finish = (result: PreToolUseHookResult & { stdout?: string; stderr?: string }) => {
      if (settled) return
      settled = true
      clearTimeout(timeoutId)
      resolve(result)
    }

    const append = (current: string, chunk: Buffer): string => {
      if (current.length >= MAX_HOOK_OUTPUT_BYTES) return current
      const next = current + chunk.toString()
      return next.length > MAX_HOOK_OUTPUT_BYTES ? next.slice(0, MAX_HOOK_OUTPUT_BYTES) : next
    }

    const timeoutId = setTimeout(() => {
      timedOut = true
      proc.kill()
    }, timeoutMs)

    proc.stdout.on('data', (chunk: Buffer) => {
      stdout = append(stdout, chunk)
    })

    proc.stderr.on('data', (chunk: Buffer) => {
      stderr = append(stderr, chunk)
    })

    proc.on('error', (error: Error) => {
      finish({
        ok: false,
        content: `${failurePrefix}: ${error.message}`,
        details: { command: hook.command, error: error.message },
      })
    })

    proc.on('close', (code: number | null, childSignal: NodeJS.Signals | null) => {
      if (timedOut) {
        finish({
          ok: false,
          content: `${timeoutPrefix}: ${hook.command}`,
          details: { command: hook.command, timeoutMs, stdout, stderr },
        })
        return
      }

      if (code === 0) {
        finish({ ok: true, stdout, stderr })
        return
      }

      const output = formatHookOutput(stdout, stderr)
      finish({
        ok: false,
        content: `${blockedPrefix}: ${hook.command} exited with code ${code ?? 'unknown'}.${output}`,
        details: { command: hook.command, exitCode: code, signal: childSignal, stdout, stderr },
        stdout,
        stderr,
      })
    })

    proc.stdin.end(JSON.stringify({
      hook: hookName,
      ...input,
    }))
  })
}

function formatHookOutput(stdout: string, stderr: string): string {
  const parts: string[] = []
  if (stdout.trim()) parts.push(`stdout:\n${stdout.trim()}`)
  if (stderr.trim()) parts.push(`stderr:\n${stderr.trim()}`)
  return parts.length > 0 ? `\n${parts.join('\n')}` : ''
}

function parseLifecycleHookControl(stdout: string, stderr: string): LifecycleHookOutput {
  const visibleStdout: string[] = []
  const blockingErrors: string[] = []
  let preventContinuation = false
  const stdoutLines = stdout.split(/\r?\n/)

  for (let index = 0; index < stdoutLines.length; index += 1) {
    const line = stdoutLines[index] ?? ''
    if (line.trim() !== '__HANEKAWA_HOOK__') {
      visibleStdout.push(line)
      continue
    }

    const payload = stdoutLines[index + 1]
    if (payload === undefined) continue
    index += 1
    try {
      const parsed = JSON.parse(payload) as unknown
      if (!parsed || typeof parsed !== 'object') continue
      const control = parsed as {
        preventContinuation?: unknown
        blockingError?: unknown
        blockingErrors?: unknown
      }
      preventContinuation ||= control.preventContinuation === true
      if (typeof control.blockingError === 'string' && control.blockingError.trim()) {
        blockingErrors.push(control.blockingError.trim())
      }
      if (Array.isArray(control.blockingErrors)) {
        for (const item of control.blockingErrors) {
          if (typeof item === 'string' && item.trim()) blockingErrors.push(item.trim())
        }
      }
    } catch {
      visibleStdout.push(line, payload)
    }
  }

  for (const line of stderr.split(/\r?\n/)) {
    const match = /^BLOCKING:\s*(.+)$/i.exec(line.trim())
    if (match?.[1]) blockingErrors.push(match[1].trim())
  }

  return {
    stdout: visibleStdout.join('\n').trim(),
    failures: [],
    blockingErrors,
    preventContinuation,
  }
}
