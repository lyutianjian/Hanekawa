import { shellWords, splitShellSegments } from './bashSafety.js'

export interface DestructiveCommandWarning {
  code: string
  message: string
  segment: string
}

const SQL_CLIENTS = new Set(['mysql', 'mysql.exe', 'psql', 'psql.exe', 'sqlite3', 'sqlite3.exe'])

export function analyzeDestructiveCommands(command: string): DestructiveCommandWarning[] {
  const warnings: DestructiveCommandWarning[] = []
  const segments = splitShellSegments(command)

  for (const segment of segments) {
    const words = shellWords(segment)
    if (words.length === 0) continue
    const executable = basename(words[0]!).toLowerCase()
    const args = words.slice(1)

    if (executable === 'rm' && hasShortOrLongFlag(args, 'r', '--recursive') && hasShortOrLongFlag(args, 'f', '--force')) {
      warnings.push(warning('recursive_force_delete', 'Recursively force-deletes files or directories.', segment))
    }

    if (executable === 'del' || executable === 'erase' || executable === 'rmdir' || executable === 'rd') {
      warnings.push(warning('windows_delete', 'Deletes files or directories using a Windows shell command.', segment))
    }

    if (executable === 'remove-item' && args.some((arg) => {
      const lower = arg.toLowerCase()
      return lower === '-recurse' || lower === '-force' || lower === '-r'
    })) {
      warnings.push(warning('powershell_recursive_delete', 'Recursively or forcibly deletes items with PowerShell.', segment))
    }

    if (executable === 'git') collectGitWarnings(args, segment, warnings)
  }

  if (segments.some((segment) => SQL_CLIENTS.has(basename(shellWords(segment)[0] ?? '').toLowerCase()))) {
    const sqlPatterns: Array<[RegExp, string, string]> = [
      [/\bdrop\s+(?:table|database|schema)\b/i, 'sql_drop', 'Drops a SQL table, database, or schema.'],
      [/\btruncate\s+(?:table\s+)?[A-Za-z_`"[]/i, 'sql_truncate', 'Truncates a SQL table and removes its rows.'],
    ]
    for (const [pattern, code, message] of sqlPatterns) {
      if (pattern.test(command)) warnings.push(warning(code, message, command.trim()))
    }
  }

  return dedupeWarnings(warnings)
}

function collectGitWarnings(
  args: string[],
  segment: string,
  warnings: DestructiveCommandWarning[],
): void {
  const lower = args.map((arg) => arg.toLowerCase())
  const resetIndex = lower.indexOf('reset')
  if (resetIndex !== -1 && lower.slice(resetIndex + 1).includes('--hard')) {
    warnings.push(warning('git_reset_hard', 'Discards tracked working-tree and index changes with git reset --hard.', segment))
  }

  const cleanIndex = lower.indexOf('clean')
  if (cleanIndex !== -1 && lower.slice(cleanIndex + 1).some((arg) => arg === '--force' || /^-[^-]*f/.test(arg))) {
    warnings.push(warning('git_clean_force', 'Force-deletes untracked files with git clean.', segment))
  }

  const pushIndex = lower.indexOf('push')
  if (pushIndex !== -1 && lower.slice(pushIndex + 1).some((arg) => (
    arg === '--force' || arg.startsWith('--force=') || arg.startsWith('--force-with-lease') || /^-[^-]*f/.test(arg)
  ))) {
    warnings.push(warning('git_push_force', 'Force-pushes and may overwrite shared remote history.', segment))
  }

  const checkoutIndex = lower.indexOf('checkout')
  if (checkoutIndex !== -1) {
    const checkoutArgs = lower.slice(checkoutIndex + 1)
    if (checkoutArgs.includes('--') || checkoutArgs.includes('.') || checkoutArgs.includes('--force') || checkoutArgs.includes('-f')) {
      warnings.push(warning('git_checkout_discard', 'May discard working-tree changes with git checkout.', segment))
    }
  }
}

function hasShortOrLongFlag(args: string[], shortFlag: string, longFlag: string): boolean {
  return args.some((arg) => {
    const lower = arg.toLowerCase()
    if (lower === longFlag) return true
    return lower.startsWith('-') && !lower.startsWith('--') && lower.slice(1).includes(shortFlag)
  })
}

function warning(code: string, message: string, segment: string): DestructiveCommandWarning {
  return { code, message, segment }
}

function dedupeWarnings(warnings: DestructiveCommandWarning[]): DestructiveCommandWarning[] {
  const seen = new Set<string>()
  return warnings.filter((entry) => {
    const key = `${entry.code}\0${entry.segment}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function basename(command: string): string {
  const normalized = command.replace(/\\/g, '/')
  const slash = normalized.lastIndexOf('/')
  return slash === -1 ? normalized : normalized.slice(slash + 1)
}
