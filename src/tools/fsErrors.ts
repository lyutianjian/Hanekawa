/**
 * Filesystem errno codes reach the model as-is otherwise: a bare
 * "ENOTDIR: not a directory, scandir 'C:\...\clash.yaml'" says nothing about
 * what to do next, so the model retries the same call. Each mapping below adds
 * the one sentence that makes the failure recoverable in a single turn.
 */
const ERRNO_ADVICE: Record<string, string> = {
  ENOENT: 'The path does not exist. Check the spelling, or use Glob to locate it.',
  ENOTDIR: 'A component of the path is a file, not a directory. If you meant to target that file, pass it directly.',
  EISDIR: 'The path is a directory, not a file.',
  EACCES: 'Permission denied by the operating system.',
  EPERM: 'The operation is not permitted on this path.',
  EMFILE: 'Too many open files. Retry once.',
  ENFILE: 'Too many open files on the system. Retry once.',
  ELOOP: 'The path contains a symlink loop.',
  ENAMETOOLONG: 'The path is too long.',
}

function errnoOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' && code in ERRNO_ADVICE ? code : undefined
}

/**
 * Turn a thrown error into a message the model can act on. `toolName` and `cwd`
 * are prepended because a tool result carries neither on its own.
 */
export function describeToolError(toolName: string, error: unknown, cwd?: string): string {
  const base = error instanceof Error ? error.message : String(error)
  const advice = errnoOf(error)
  const parts = [`${toolName} failed: ${base}`]
  if (advice) parts.push(ERRNO_ADVICE[advice]!)
  if (advice === 'ENOENT' && cwd) parts.push(`Relative paths resolve against ${cwd}.`)
  return parts.join(' ')
}
