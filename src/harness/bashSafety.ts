import { containsProtectedPath } from '../utils/permissions/protectedPaths.js'

export const MAX_SHELL_SEGMENTS = 50

export type BashSafetySeverity = 'deny' | 'prompt'

export interface BashSafetyIssue {
  code: string
  message: string
  severity: BashSafetySeverity
  segment?: string
}

export interface BashSafetyAnalysis {
  command: string
  segments: string[]
  issues: BashSafetyIssue[]
  hasDenyIssue: boolean
  requiresPrompt: boolean
  hasProtectedPath: boolean
  categories: string[]
}

const PREFIX_COMMANDS = new Set([
  'sudo',
  'su',
  'doas',
  'bash',
  'sh',
  'zsh',
  'fish',
  'dash',
  'ksh',
  'env',
])

const ZSH_DANGEROUS_BUILTINS = new Set([
  'emulate',
  'sysopen',
  'zcompile',
  'zmodload',
  'zparseopts',
])

type QuoteState = 'single' | 'double' | 'ansi' | undefined

export function splitShellSegments(command: string): string[] {
  const segments: string[] = []
  let current = ''
  let quote: QuoteState
  let escaped = false

  const push = () => {
    const segment = current.trim()
    if (segment) segments.push(segment)
    current = ''
  }

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]
    const next = command[i + 1]

    if (escaped) {
      current += ch
      escaped = false
      continue
    }

    if (ch === '\\' && quote !== 'single') {
      current += ch
      escaped = true
      continue
    }

    if (quote) {
      current += ch
      if ((quote === 'single' || quote === 'ansi') && ch === '\'') quote = undefined
      if (quote === 'double' && ch === '"') quote = undefined
      continue
    }

    if (ch === '$' && next === '\'') {
      current += ch
      continue
    }

    if (ch === '\'') {
      quote = 'single'
      current += ch
      continue
    }

    if (ch === '"') {
      quote = 'double'
      current += ch
      continue
    }

    if ((ch === '&' && next === '&') || (ch === '|' && next === '|')) {
      push()
      i++
      continue
    }

    if (ch === ';' || ch === '|' || ch === '\n') {
      push()
      continue
    }

    current += ch
  }

  push()
  return segments
}

export function analyzeBashSafety(command: string): BashSafetyAnalysis {
  const issues: BashSafetyIssue[] = []
  const segments = splitShellSegments(command)

  if (command.includes('\r')) {
    issues.push({ code: 'carriage_return', message: 'contains a carriage return', severity: 'deny' })
  }

  if (command.includes('\\\\')) {
    issues.push({ code: 'unc_path', message: 'contains a UNC-style path', severity: 'deny' })
  }

  collectSyntaxIssues(command, issues)

  if (segments.length > MAX_SHELL_SEGMENTS) {
    issues.push({
      code: 'too_many_segments',
      message: `contains more than ${MAX_SHELL_SEGMENTS} shell segments`,
      severity: 'deny',
    })
  }

  for (const segment of segments) {
    const prefix = shellPrefix(segment)
    if (prefix) {
      issues.push({
        code: 'shell_prefix',
        message: `uses ${prefix} as a command prefix`,
        severity: 'prompt',
        segment,
      })
    }

    const dangerousBuiltin = zshDangerousBuiltin(segment)
    if (dangerousBuiltin) {
      issues.push({
        code: 'zsh_dangerous_builtin',
        message: `uses dangerous zsh builtin ${dangerousBuiltin}`,
        severity: 'deny',
        segment,
      })
    }
  }

  const hasProtectedPath = segments.some((segment) => containsProtectedPath(segment))
    || (segments.length === 0 && containsProtectedPath(command))

  const categories = [...new Set(issues.map((issue) => {
    if (issue.code === 'shell_prefix') return 'shell wrapper or privilege prefix'
    return `unsafe shell syntax: ${issue.message}`
  }))]

  return {
    command,
    segments,
    issues,
    hasDenyIssue: issues.some((issue) => issue.severity === 'deny'),
    requiresPrompt: issues.some((issue) => issue.severity === 'prompt'),
    hasProtectedPath,
    categories,
  }
}

function collectSyntaxIssues(command: string, issues: BashSafetyIssue[]): void {
  let quote: QuoteState
  let escaped = false

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]
    const next = command[i + 1]

    if (escaped) {
      escaped = false
      continue
    }

    if (ch === '\\' && quote !== 'single') {
      escaped = true
      continue
    }

    if (quote === 'single' || quote === 'ansi') {
      if (ch === '\'') quote = undefined
      continue
    }

    if (quote === 'double') {
      if (ch === '"') {
        quote = undefined
        continue
      }
      if (ch === '\n') {
        issues.push({ code: 'quoted_newline', message: 'contains a newline inside double quotes', severity: 'deny' })
      }
      if (ch === '$' && next === '(') {
        issues.push({ code: 'command_substitution', message: 'contains command substitution', severity: 'deny' })
      }
      if (ch === '`') {
        issues.push({ code: 'backticks', message: 'contains backtick command substitution', severity: 'deny' })
      }
      continue
    }

    if (ch === '$' && next === '\'') {
      issues.push({ code: 'ansi_c_quote', message: 'contains ANSI-C shell quoting', severity: 'deny' })
      quote = 'ansi'
      i++
      continue
    }

    if ((ch === '\'' && next === '\'') || (ch === '"' && next === '"')) {
      const previous = command[i - 1]
      const after = command[i + 2]
      if ((previous === undefined || /\s/.test(previous)) && (after === undefined || /\s/.test(after))) {
        issues.push({ code: 'obfuscated_flags', message: 'contains a standalone empty quoted argument', severity: 'deny' })
      }
      i++
      continue
    }

    if (ch === '\'') {
      quote = 'single'
      continue
    }

    if (ch === '"') {
      quote = 'double'
      continue
    }

    if (ch === '#' && hasQuoteAfterComment(command, i + 1)) {
      issues.push({ code: 'comment_quote_desync', message: 'contains quote characters after a shell comment', severity: 'deny' })
      continue
    }

    if (ch === '$' && next === '(') {
      issues.push({ code: 'command_substitution', message: 'contains command substitution', severity: 'deny' })
      continue
    }

    if (ch === '`') {
      issues.push({ code: 'backticks', message: 'contains backtick command substitution', severity: 'deny' })
      continue
    }

    if (ch === '<' || ch === '>') {
      issues.push({ code: 'redirection', message: 'contains shell redirection', severity: 'deny' })
    }
  }

  if (quote) {
    issues.push({ code: 'unclosed_quote', message: 'contains an unclosed shell quote', severity: 'deny' })
  }
}

function zshDangerousBuiltin(segment: string): string | undefined {
  const words = shellWords(segment)
  for (const word of words) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=.*/.test(word)) continue
    const command = basename(word).toLowerCase()
    return ZSH_DANGEROUS_BUILTINS.has(command) ? command : undefined
  }
  return undefined
}

function shellPrefix(segment: string): string | undefined {
  const words = shellWords(segment)
  for (const word of words) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=.*/.test(word)) continue
    const command = basename(word).toLowerCase()
    return PREFIX_COMMANDS.has(command) ? command : undefined
  }
  return undefined
}

export function shellWords(segment: string): string[] {
  const words: string[] = []
  let current = ''
  let quote: QuoteState
  let escaped = false

  const push = () => {
    if (current) words.push(current)
    current = ''
  }

  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i]
    const next = segment[i + 1]

    if (escaped) {
      current += ch
      escaped = false
      continue
    }

    if (ch === '\\' && quote !== 'single') {
      escaped = true
      continue
    }

    if (quote) {
      if ((quote === 'single' || quote === 'ansi') && ch === '\'') quote = undefined
      else if (quote === 'double' && ch === '"') quote = undefined
      else current += ch
      continue
    }

    if (/\s/.test(ch)) {
      push()
      continue
    }

    if (ch === '$' && next === '\'') {
      quote = 'ansi'
      i++
      continue
    }

    if (ch === '\'') {
      quote = 'single'
      continue
    }

    if (ch === '"') {
      quote = 'double'
      continue
    }

    current += ch
  }

  push()
  return words
}

function hasQuoteAfterComment(command: string, start: number): boolean {
  for (let i = start; i < command.length; i++) {
    const ch = command[i]
    if (ch === '\n') return false
    if (ch === '\'' || ch === '"' || ch === '`') return true
  }
  return false
}

function basename(command: string): string {
  const normalized = command.replace(/\\/g, '/')
  const slash = normalized.lastIndexOf('/')
  return slash === -1 ? normalized : normalized.slice(slash + 1)
}
