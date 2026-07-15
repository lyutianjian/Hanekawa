import { analyzeBashSafety, shellWords } from './bashSafety.js'
import { analyzeDestructiveCommands, type DestructiveCommandWarning } from './destructiveCommands.js'
export { containsProtectedPath } from '../utils/permissions/protectedPaths.js'

const SHELL_OPERATORS = /&&|\|\||[;|]/
const REDIRECTION = /(^|[^<])>{1,2}|<{1,2}/

export interface CommandAnalysis {
  command: string
  segments: string[]
  hasProtectedPath: boolean
  hasSafetyDenyIssue: boolean
  requiresSafetyPrompt: boolean
  isComplex: boolean
  isReadOnly: boolean
  destructiveWarnings: DestructiveCommandWarning[]
  categories: string[]
}

export function analyzeShellCommand(command: string): CommandAnalysis {
  const safety = analyzeBashSafety(command)
  const segments = safety.segments
  const categories = new Set<string>()
  const lower = command.toLowerCase()
  const destructiveWarnings = analyzeDestructiveCommands(command)

  if (SHELL_OPERATORS.test(command) || REDIRECTION.test(command)) {
    categories.add('complex shell command')
  }

  if (destructiveWarnings.length > 0 || isAdditionalDestructiveCommand(lower)) {
    categories.add('destructive filesystem or git operation')
  }

  if (hasExternalSideEffect(lower)) {
    categories.add('external or shared-state operation')
  }

  for (const category of safety.categories) {
    categories.add(category)
  }

  return {
    command,
    segments,
    hasProtectedPath: safety.hasProtectedPath,
    hasSafetyDenyIssue: safety.hasDenyIssue,
    requiresSafetyPrompt: safety.requiresPrompt,
    isComplex: categories.has('complex shell command'),
    isReadOnly: isReadOnlyShellCommand(command, safety),
    destructiveWarnings,
    categories: [...categories],
  }
}

const READ_ONLY_SHELL_COMMANDS = new Set([
  'cat',
  'dir',
  'fd',
  'find',
  'get-childitem',
  'get-content',
  'grep',
  'head',
  'ls',
  'pwd',
  'rg',
  'ripgrep',
  'sed',
  'select-string',
  'stat',
  'tail',
  'wc',
])

const READ_ONLY_GIT_SUBCOMMANDS = new Set([
  'diff',
  'grep',
  'log',
  'ls-files',
  'rev-parse',
  'shortlog',
  'show',
  'show-ref',
  'status',
])

interface SafetyShape {
  segments: string[]
  hasDenyIssue: boolean
  requiresPrompt: boolean
}

function isReadOnlyShellCommand(command: string, safety: SafetyShape): boolean {
  if (safety.hasDenyIssue || safety.requiresPrompt) return false
  if (safety.segments.length === 0 || !hasWellFormedReadOnlyControlSyntax(command)) return false
  return safety.segments.every(isReadOnlySegment)
}

function isReadOnlySegment(segment: string): boolean {
  const words = shellWords(segment)
  if (words.length === 0) return false
  const executable = normalizedExecutable(words[0]!)
  const args = words.slice(1)

  if (executable === 'git') return isReadOnlyGit(args)
  if (executable === 'node') {
    return args.length === 1 && (args[0]?.toLowerCase() === '-v' || args[0]?.toLowerCase() === '--version')
  }
  if (!READ_ONLY_SHELL_COMMANDS.has(executable)) return false
  if (executable === 'fd') return isReadOnlyFd(args)
  if (executable === 'find') return isReadOnlyFind(args)
  if (executable === 'rg' || executable === 'ripgrep') return isReadOnlyRipgrep(args)
  if (executable === 'sed') return isReadOnlySed(args)
  return true
}

function isReadOnlyGit(args: string[]): boolean {
  let index = 0
  while (index < args.length) {
    const arg = args[index]!
    const lower = arg.toLowerCase()
    if (lower === '--no-pager') {
      index++
      continue
    }
    if (arg === '-C' || lower === '--git-dir' || lower === '--work-tree' || lower === '--namespace') {
      if (index + 1 >= args.length) return false
      index += 2
      continue
    }
    if (lower === '-c' || lower === '--config-env') return false
    if (lower.startsWith('--git-dir=') || lower.startsWith('--work-tree=') || lower.startsWith('--namespace=')) {
      index++
      continue
    }
    break
  }

  const subcommand = args[index]?.toLowerCase()
  if (!subcommand || !READ_ONLY_GIT_SUBCOMMANDS.has(subcommand)) return false
  const rawSubcommandArgs = args.slice(index + 1)
  const subcommandArgs = rawSubcommandArgs.map((arg) => arg.toLowerCase())
  return !subcommandArgs.some((arg) => (
    arg === '--ext-diff'
    || arg === '--textconv'
    || arg === '--exec'
    || arg.startsWith('--exec=')
    || arg === '--output'
    || arg.startsWith('--output=')
    || arg === '--open-files-in-pager'
    || arg.startsWith('--open-files-in-pager=')
  )) && !(subcommand === 'grep' && rawSubcommandArgs.some((arg) => arg === '-O' || arg.startsWith('-O')))
}

function isReadOnlyFd(args: string[]): boolean {
  return !args.some((arg) => {
    const lower = arg.toLowerCase()
    return lower === '--exec' || lower === '--exec-batch' || /^-[a-z]*x[a-z]*$/.test(lower)
  })
}

function isReadOnlyFind(args: string[]): boolean {
  return !args.some((arg) => {
    const lower = arg.toLowerCase()
    return lower === '-delete'
      || lower === '-exec'
      || lower === '-execdir'
      || lower === '-ok'
      || lower === '-okdir'
      || lower === '-fls'
      || lower === '-fprint'
      || lower === '-fprint0'
      || lower === '-fprintf'
  })
}

function isReadOnlyRipgrep(args: string[]): boolean {
  return !args.some((arg) => {
    const lower = arg.toLowerCase()
    return lower === '--pre'
      || lower.startsWith('--pre=')
      || lower === '--hostname-bin'
      || lower.startsWith('--hostname-bin=')
  })
}

function isReadOnlySed(args: string[]): boolean {
  if (args.length === 0) return false
  const scripts: string[] = []
  let index = 0
  let hasScript = false

  while (index < args.length) {
    const arg = args[index]!
    const lower = arg.toLowerCase()
    if (lower === '--') {
      index++
      break
    }
    if (lower.startsWith('--in-place') || /^-[^-]*i/i.test(arg)) return false
    if (lower === '-f' || lower === '--file' || lower.startsWith('--file=')) return false
    if (lower === '-e' || lower === '--expression') {
      const script = args[index + 1]
      if (!script) return false
      scripts.push(script)
      hasScript = true
      index += 2
      continue
    }
    if (lower.startsWith('--expression=')) {
      scripts.push(arg.slice(arg.indexOf('=') + 1))
      hasScript = true
      index++
      continue
    }
    if (arg.startsWith('-')) {
      index++
      continue
    }
    if (!hasScript) {
      scripts.push(arg)
      hasScript = true
    }
    index++
  }

  if (!hasScript || index > args.length) return false
  return scripts.every((script) => !hasDangerousSedScript(script))
}

function hasDangerousSedScript(script: string): boolean {
  const address = String.raw`(?:(?:[0-9]+|\$|\/(?:\\.|[^/])*\/)(?:\s*,\s*(?:[0-9]+|\$|\/(?:\\.|[^/])*\/))?\s*)?`
  const commandWriteOrExecute = new RegExp(String.raw`(^|[;\n])\s*${address}[eEwW](?:\s|$)`)
  const substitutionWriteOrExecute = /s(.)(?:\\.|(?!\1).)*\1(?:\\.|(?!\1).)*\1[^;\s]*[eEwW]/
  return commandWriteOrExecute.test(script) || substitutionWriteOrExecute.test(script)
}

function hasWellFormedReadOnlyControlSyntax(command: string): boolean {
  let quote: 'single' | 'double' | undefined
  let escaped = false
  let expectCommand = true
  let sawOperator = false

  for (let index = 0; index < command.length; index++) {
    const ch = command[index]!
    const next = command[index + 1]
    if (escaped) {
      escaped = false
      if (!/\s/.test(ch)) expectCommand = false
      continue
    }
    if (ch === '\\' && quote !== 'single') {
      escaped = true
      continue
    }
    if (quote) {
      if ((quote === 'single' && ch === '\'') || (quote === 'double' && ch === '"')) quote = undefined
      expectCommand = false
      continue
    }
    if (ch === '\'' || ch === '"') {
      quote = ch === '\'' ? 'single' : 'double'
      expectCommand = false
      continue
    }
    if (ch === '(' || ch === ')' || ch === '{' || ch === '}' || ch === '<' || ch === '>') return false
    const isDoubleOperator = (ch === '&' && next === '&') || (ch === '|' && next === '|')
    const isSingleOperator = ch === '|' || ch === ';' || ch === '\n'
    if (ch === '&' && next !== '&') return false
    if (isDoubleOperator || isSingleOperator) {
      if (expectCommand) return false
      expectCommand = true
      sawOperator = true
      if (isDoubleOperator) index++
      continue
    }
    if (!/\s/.test(ch)) expectCommand = false
  }

  return !quote && !escaped && !(sawOperator && expectCommand) && !expectCommand
}

function isAdditionalDestructiveCommand(command: string): boolean {
  if (hasWriteLikeReadCommandFlags(command)) return true

  return [
    /(^|\s)git\s+reset\s+--hard\b/,
    /(^|\s)git\s+clean\s+[^;&|]*-[^\s]*f\b/,
    /(^|\s)git\s+checkout\b[^;&|]*\s--\s+/,
    /(^|\s)(del|erase|rmdir|rd)\b/,
  ].some((pattern) => pattern.test(command))
}

function hasWriteLikeReadCommandFlags(command: string): boolean {
  for (const segment of analyzeBashSafety(command).segments) {
    const words = shellWords(segment)
    if (words.length === 0) continue
    const executable = basename(words[0]!).toLowerCase()
    const args = words.slice(1).map((word) => word.toLowerCase())

    if ((executable === 'sed' || executable === 'perl') && args.some(isInPlaceFlag)) return true
    if (executable === 'fd' && args.some(isFdExecFlag)) return true
    if (executable === 'find' && args.some((arg) => arg === '-delete' || arg === '-exec' || arg === '-execdir')) return true
  }
  return false
}

function isInPlaceFlag(arg: string): boolean {
  return arg === '-i' || arg.startsWith('-i.') || arg.startsWith('-i' + '.')
    || /^-[a-z]*i[a-z]*$/.test(arg)
    || arg === '--in-place'
    || arg.startsWith('--in-place=')
}

function isFdExecFlag(arg: string): boolean {
  return arg === '--exec'
    || arg === '--exec-batch'
    || /^-[a-z]*x[a-z]*$/.test(arg)
}

function hasExternalSideEffect(command: string): boolean {
  return [
    /(^|\s)git\s+push\b/,
    /(^|\s)gh\s+(pr|issue)\b/,
    /(^|\s)(npm|pnpm|yarn|bun)\s+(install|add|remove|update|upgrade)\b/,
    /(^|\s)pip\s+install\b/,
    /(^|\s)cargo\s+(add|install|update)\b/,
    /(^|\s)go\s+get\b/,
    /(^|\s)(curl|wget)\b/,
  ].some((pattern) => pattern.test(command))
}

function basename(command: string): string {
  const normalized = command.replace(/\\/g, '/')
  const slash = normalized.lastIndexOf('/')
  return slash === -1 ? normalized : normalized.slice(slash + 1)
}

function normalizedExecutable(command: string): string {
  const base = basename(command).toLowerCase()
  return base.endsWith('.exe') ? base.slice(0, -4) : base
}
