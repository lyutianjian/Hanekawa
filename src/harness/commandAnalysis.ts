import { analyzeBashSafety, shellWords, splitShellSegments, stripDiscardRedirections } from './bashSafety.js'
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
  destructiveWarnings: DestructiveCommandWarning[]
  categories: string[]
}

export function analyzeShellCommand(command: string): CommandAnalysis {
  const safety = analyzeBashSafety(command)
  const segments = safety.segments
  const categories = new Set<string>()
  const lower = command.toLowerCase()
  const destructiveWarnings = analyzeDestructiveCommands(command)

  // Discard redirections do not make a command complex, so judge the stripped form.
  const withoutDiscards = stripDiscardRedirections(command)
  if (SHELL_OPERATORS.test(withoutDiscards) || REDIRECTION.test(withoutDiscards)) {
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
    destructiveWarnings,
    categories: [...categories],
  }
}

export interface SedInvocation {
  scripts: string[]
  /** Input files: every operand past the leading inline script, if there is one. */
  operands: string[]
  /** Every flag token, in order, unexpanded (`-nE` stays `-nE`). */
  flags: string[]
  inPlace: boolean
  /** `-f script.sed`: the script lives in a file this analysis cannot read. */
  usesScriptFile: boolean
}

/**
 * Split a `sed` argument list into its scripts and input files. Returns
 * undefined when no script is present at all, which is not a runnable sed.
 */
export function parseSedInvocation(args: string[]): SedInvocation | undefined {
  const scripts: string[] = []
  const operands: string[] = []
  const flags: string[] = []
  let inPlace = false
  let usesScriptFile = false
  let hasScript = false
  let index = 0
  let endOfFlags = false

  while (index < args.length) {
    const arg = args[index]!
    const lower = arg.toLowerCase()
    if (!endOfFlags && lower === '--') {
      endOfFlags = true
      index++
      continue
    }
    if (!endOfFlags && arg.startsWith('-') && arg !== '-') {
      flags.push(arg)
      if (lower.startsWith('--in-place') || /^-[^-]*i/i.test(arg)) inPlace = true
      if (lower === '-f' || lower === '--file' || lower.startsWith('--file=')) {
        usesScriptFile = true
        hasScript = true
        if (lower === '-f' || lower === '--file') index++
        index++
        continue
      }
      if (lower === '-e' || lower === '--expression') {
        const script = args[index + 1]
        if (script === undefined) return undefined
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
      index++
      continue
    }
    if (!hasScript) {
      scripts.push(arg)
      hasScript = true
    } else {
      operands.push(arg)
    }
    index++
  }

  return hasScript ? { scripts, operands, flags, inPlace, usesScriptFile } : undefined
}

/**
 * Positional arguments, honouring the POSIX `--` end-of-options delimiter.
 * A naive `!startsWith('-')` filter drops everything after `--`, so
 * `rm -rf src -- -/../../elsewhere` would present only `src` for validation and
 * the second path would never be checked. Ported from Claude Code's
 * `filterOutFlags`.
 */
export function positionalArguments(args: string[]): string[] {
  const positional: string[] = []
  let endOfFlags = false
  for (const arg of args) {
    if (endOfFlags) {
      positional.push(arg)
      continue
    }
    if (arg === '--') {
      endOfFlags = true
      continue
    }
    if (!arg.startsWith('-')) positional.push(arg)
  }
  return positional
}

/**
 * Claude Code's accept-edits `sed` allowlist (`sedValidation.ts`): an in-place
 * edit is auto-approved only as a single `s/pattern/replacement/flags`
 * substitution with a `/` delimiter. `-e`, script files, multiple expressions,
 * semicolons and every other sed command (`d`, `a`, `w`, `e`, …) are outside
 * it, so they prompt. The `hasDangerousSedScript` denylist still runs on top.
 */
const ACCEPT_EDITS_SED_FLAGS = new Set(['-E', '--regexp-extended', '-r', '--posix', '-i', '--in-place'])

export function isAcceptEditsSedSubstitution(sed: SedInvocation): boolean {
  if (!sed.inPlace || sed.usesScriptFile) return false
  if (!sed.flags.every(sedFlagIsAllowed)) return false
  if (sed.scripts.length !== 1) return false

  const script = sed.scripts[0]!.trim()
  if (script.includes(';')) return false
  if (hasDangerousSedScript(script)) return false
  if (!script.startsWith('s/')) return false

  // Exactly two more unescaped `/` after the leading `s/`, then only the
  // substitution flags sed itself accepts — `w`/`e` are absent by construction.
  const rest = script.slice(2)
  let delimiters = 0
  let lastDelimiter = -1
  for (let index = 0; index < rest.length; index++) {
    if (rest[index] === '\\') {
      index++
      continue
    }
    if (rest[index] === '/') {
      delimiters++
      lastDelimiter = index
    }
  }
  if (delimiters !== 2) return false
  return /^[gpimIM]*[1-9]?[gpimIM]*$/.test(rest.slice(lastDelimiter + 1))
}

function sedFlagIsAllowed(flag: string): boolean {
  // A combined short flag (`-nE`) is allowed only if every letter in it is.
  if (flag.startsWith('-') && !flag.startsWith('--') && flag.length > 2) {
    for (const letter of flag.slice(1)) {
      if (!ACCEPT_EDITS_SED_FLAGS.has(`-${letter}`)) return false
    }
    return true
  }
  return ACCEPT_EDITS_SED_FLAGS.has(flag)
}

/**
 * A sed script that writes a file (`w`) or executes a command (`e`), in either
 * the standalone-command or the `s///` flag position. Exported so the
 * permission layer can reuse it for accept-edits `sed -i` rather than growing a
 * second copy of these regexes.
 */
export function hasDangerousSedScript(script: string): boolean {
  const address = String.raw`(?:(?:[0-9]+|\$|\/(?:\\.|[^/])*\/)(?:\s*,\s*(?:[0-9]+|\$|\/(?:\\.|[^/])*\/))?\s*)?`
  const commandWriteOrExecute = new RegExp(String.raw`(^|[;\n])\s*${address}[eEwW](?:\s|$)`)
  const substitutionWriteOrExecute = /s(.)(?:\\.|(?!\1).)*\1(?:\\.|(?!\1).)*\1[^;\s]*[eEwW]/
  return commandWriteOrExecute.test(script) || substitutionWriteOrExecute.test(script)
}

/**
 * Destructive shapes that `analyzeDestructiveCommands` does not cover. It
 * already handles `rm -rf`, the Windows delete verbs, `remove-item`, and the
 * destructive git subcommands per-segment; matching those a second time with
 * whole-string regexes only added false positives (`grep -rn del src/`).
 */
function isAdditionalDestructiveCommand(command: string): boolean {
  return hasWriteLikeReadCommandFlags(command)
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

/** Executables whose every invocation reaches outside the working tree. */
const EXTERNAL_EXECUTABLES = new Set(['curl', 'wget'])

/** Executable -> subcommands that publish, install, or otherwise reach out. */
const EXTERNAL_SUBCOMMANDS: Record<string, ReadonlySet<string>> = {
  git: new Set(['push']),
  gh: new Set(['pr', 'issue']),
  npm: new Set(['install', 'add', 'remove', 'update', 'upgrade']),
  pnpm: new Set(['install', 'add', 'remove', 'update', 'upgrade']),
  yarn: new Set(['install', 'add', 'remove', 'update', 'upgrade']),
  bun: new Set(['install', 'add', 'remove', 'update', 'upgrade']),
  pip: new Set(['install']),
  cargo: new Set(['add', 'install', 'update']),
  go: new Set(['get']),
}

/**
 * Matched per segment on the executable position, not against the whole command
 * string: `grep -rn curl src/` names curl in an argument and reaches nothing.
 */
function hasExternalSideEffect(command: string): boolean {
  for (const segment of splitShellSegments(command)) {
    const words = shellWords(segment)
    if (words.length === 0) continue
    const executable = normalizedExecutable(words[0]!)
    if (EXTERNAL_EXECUTABLES.has(executable)) return true
    const subcommands = EXTERNAL_SUBCOMMANDS[executable]
    if (!subcommands) continue
    // Subcommand position only: `git log --grep push` names push in an argument.
    const subcommand = words.slice(1).find((word) => !word.startsWith('-'))
    if (subcommand && subcommands.has(subcommand.toLowerCase())) return true
  }
  return false
}

function basename(command: string): string {
  const normalized = command.replace(/\\/g, '/')
  const slash = normalized.lastIndexOf('/')
  return slash === -1 ? normalized : normalized.slice(slash + 1)
}

export function normalizedExecutable(command: string): string {
  const base = basename(command).toLowerCase()
  return base.endsWith('.exe') ? base.slice(0, -4) : base
}
