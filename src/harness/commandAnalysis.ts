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
    isReadOnly: isReadOnlyShellCommand(command, safety),
    destructiveWarnings,
    categories: [...categories],
  }
}

/**
 * Commands that cannot change anything on their own. A few of them (`sort`,
 * `cut`, `tr`, …) can only write through a redirection, and a redirection that
 * is not a discard already fails `hasWellFormedReadOnlyControlSyntax`.
 *
 * Aligned with Claude Code's READONLY_COMMANDS / READONLY_COMMAND_REGEXES /
 * COMMAND_ALLOWLIST, with two deliberate omissions:
 *  - `xargs` runs an arbitrary command, and `shellRuleMatching.ts` already
 *    treats it as a shell wrapper no prefix rule may be suggested for; calling
 *    it read-only here would contradict that.
 *  - `man` / `info` / `help` spawn a pager, which buys little and behaves
 *    badly under a captured stdout.
 * `base64` and the `sha*sum` family carry no output-file flag in coreutils, so
 * they need no `hasOutputFileFlag` guard the way `sort` and `tree` do.
 */
const READ_ONLY_SHELL_COMMANDS = new Set([
  'alias',
  'base64',
  'basename',
  'cal',
  'cat',
  'cmp',
  'column',
  'comm',
  'cut',
  'date',
  'df',
  'diff',
  'dir',
  'dirname',
  'du',
  'echo',
  'expand',
  'expr',
  'false',
  'fd',
  'file',
  'find',
  'fmt',
  'fold',
  'free',
  'get-childitem',
  'get-content',
  'get-location',
  'getconf',
  'grep',
  'groups',
  'head',
  'hexdump',
  'history',
  'hostname',
  'id',
  'locale',
  'ls',
  'lsof',
  'md5sum',
  'netstat',
  'nl',
  'nproc',
  'numfmt',
  'od',
  'paste',
  'pgrep',
  'pr',
  'printenv',
  'printf',
  'ps',
  'pwd',
  'readlink',
  'realpath',
  'rev',
  'rg',
  'ripgrep',
  'sed',
  'select-string',
  'seq',
  'sha1sum',
  'sha256sum',
  'sleep',
  'sort',
  'ss',
  'stat',
  'strings',
  'tac',
  'tail',
  'test',
  'tput',
  'tr',
  'tree',
  'true',
  'tsort',
  'type',
  'uname',
  'unexpand',
  'uniq',
  'uptime',
  'wc',
  'where',
  'which',
  'whoami',
])

/**
 * Interpreters and CLIs that are only read-only when asked for their version or
 * help. Anything else they are handed is a program to run.
 */
const VERSION_ONLY_COMMANDS = new Set(['claude', 'node', 'python', 'python2', 'python3'])
const VERSION_ONLY_FLAGS = new Set(['-v', '-V', '--version', '-h', '--help'])

/** Docker subcommands that only report state. */
const READ_ONLY_DOCKER_SUBCOMMANDS = new Set(['ps', 'images', 'logs', 'inspect'])

const READ_ONLY_GIT_SUBCOMMANDS = new Set([
  'blame',
  'cat-file',
  'describe',
  'diff',
  'for-each-ref',
  'grep',
  'log',
  'ls-files',
  'ls-remote',
  'ls-tree',
  'merge-base',
  'reflog',
  'rev-list',
  'rev-parse',
  'shortlog',
  'show',
  'show-ref',
  'status',
  'whatchanged',
])

/**
 * Git subcommands that are read-only only for specific verbs. `bareIsReadOnly`
 * covers the subcommands that report state when handed no verb at all
 * (`git remote`), which `git stash` and `git worktree` do not.
 */
const READ_ONLY_GIT_SUBCOMMAND_VERBS: Record<string, { verbs: ReadonlySet<string>; bareIsReadOnly: boolean }> = {
  remote: { verbs: new Set(['show', 'get-url']), bareIsReadOnly: true },
  stash: { verbs: new Set(['list', 'show']), bareIsReadOnly: false },
  worktree: { verbs: new Set(['list']), bareIsReadOnly: false },
}

/** `git config` reads only when one of these selectors is present. */
const GIT_CONFIG_READ_FLAGS = new Set(['--get', '--get-all', '--get-regexp', '--get-urlmatch', '--list', '-l'])
const GIT_CONFIG_WRITE_FLAGS = new Set([
  '--add',
  '--unset',
  '--unset-all',
  '--replace-all',
  '--rename-section',
  '--remove-section',
  '-e',
  '--edit',
])

/**
 * `git tag` and `git branch` list when given only listing flags; a positional
 * operand creates a ref, so it is never read-only.
 */
const GIT_REF_LIST_FLAGS = new Set([
  '-l',
  '--list',
  '-a',
  '--all',
  '-r',
  '--remotes',
  '-v',
  '-vv',
  '--verbose',
  '-i',
  '--ignore-case',
  '--show-current',
  '--omit-empty',
  '--column',
  '--no-column',
  '--merged',
  '--no-merged',
  '--contains',
  '--no-contains',
  '--points-at',
  '--sort',
  '--format',
])
const GIT_REF_LIST_VALUE_FLAGS = new Set(['--merged', '--no-merged', '--contains', '--no-contains', '--points-at', '--sort', '--format'])

interface SafetyShape {
  segments: string[]
  hasDenyIssue: boolean
  requiresPrompt: boolean
}

function isReadOnlyShellCommand(command: string, safety: SafetyShape): boolean {
  if (safety.hasDenyIssue || safety.requiresPrompt) return false
  // Discard redirections (`2>&1`, `>/dev/null`) are not writes, but the control
  // syntax check rejects every `<`/`>`, so strip them before asking.
  if (safety.segments.length === 0 || !hasWellFormedReadOnlyControlSyntax(stripDiscardRedirections(command))) return false
  return safety.segments.every(isReadOnlySegment)
}

function isReadOnlySegment(rawSegment: string): boolean {
  const segment = stripDiscardRedirections(rawSegment)
  const words = shellWords(segment)
  if (words.length === 0) return false
  const executable = normalizedExecutable(words[0]!)
  const args = words.slice(1)

  if (executable === 'git') return isReadOnlyGit(args)
  if (executable === 'docker') return isReadOnlyDocker(args)
  if (VERSION_ONLY_COMMANDS.has(executable)) {
    return args.length === 1 && VERSION_ONLY_FLAGS.has(args[0]!.toLowerCase())
  }
  if (!READ_ONLY_SHELL_COMMANDS.has(executable)) return false
  if (executable === 'fd') return isReadOnlyFd(args)
  if (executable === 'find') return isReadOnlyFind(args)
  if (executable === 'rg' || executable === 'ripgrep') return isReadOnlyRipgrep(args)
  if (executable === 'sed') return isReadOnlySed(args)
  // Read commands that grow an output-file flag are read-only only without it.
  if (executable === 'sort' || executable === 'tree') return !hasOutputFileFlag(args)
  if (executable === 'date') return !args.some((arg) => arg === '-s' || arg.toLowerCase().startsWith('--set'))
  // `uniq INPUT OUTPUT` writes its second operand.
  if (executable === 'uniq') return args.filter((arg) => !arg.startsWith('-')).length <= 1
  return true
}

function hasOutputFileFlag(args: string[]): boolean {
  return args.some((arg) => {
    const lower = arg.toLowerCase()
    return lower === '-o' || lower === '--output' || lower.startsWith('--output=') || /^-o./.test(lower)
  })
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
    // `-c`, `--config-env` and `--exec-path` all redirect what git executes.
    if (lower === '-c' || lower === '--config-env' || lower === '--exec-path' || lower.startsWith('--exec-path=')) {
      return false
    }
    if (lower.startsWith('--git-dir=') || lower.startsWith('--work-tree=') || lower.startsWith('--namespace=')) {
      index++
      continue
    }
    break
  }

  const subcommand = args[index]?.toLowerCase()
  if (!subcommand) return false
  const readOnlyVerbs = READ_ONLY_GIT_SUBCOMMAND_VERBS[subcommand]
  if (readOnlyVerbs) {
    const rest = args.slice(index + 1)
    const verb = rest.find((arg) => !arg.startsWith('-'))?.toLowerCase()
    if (verb === undefined) {
      return readOnlyVerbs.bareIsReadOnly && rest.every((arg) => arg === '-v' || arg === '--verbose')
    }
    return readOnlyVerbs.verbs.has(verb)
  }
  if (subcommand === 'config') return isReadOnlyGitConfig(args.slice(index + 1))
  if (subcommand === 'tag' || subcommand === 'branch') return isReadOnlyGitRefListing(args.slice(index + 1))
  if (!READ_ONLY_GIT_SUBCOMMANDS.has(subcommand)) return false
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

/**
 * `git config` reads only with an explicit read selector. A bare `name value`
 * pair writes, and `--get name value` would too, so the operand count is
 * capped at one on top of the selector check.
 */
function isReadOnlyGitConfig(args: string[]): boolean {
  let hasReadFlag = false
  const operands: string[] = []

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    const lower = arg.toLowerCase()
    if (GIT_CONFIG_WRITE_FLAGS.has(lower)) return false
    if (GIT_CONFIG_READ_FLAGS.has(lower)) {
      hasReadFlag = true
      continue
    }
    if (lower === '-f' || lower === '--file' || lower === '--blob') {
      index++
      continue
    }
    if (arg.startsWith('-')) continue
    operands.push(arg)
  }

  return hasReadFlag && operands.length <= 1
}

/**
 * `git tag` / `git branch` list only when handed listing flags alone: any
 * positional operand creates a ref, and the delete/move/force flags are not on
 * the listing list at all.
 */
function isReadOnlyGitRefListing(args: string[]): boolean {
  let explicitList = false
  let operands = 0

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    const lower = arg.toLowerCase()
    if (lower.startsWith('--') && lower.includes('=')) {
      if (!GIT_REF_LIST_FLAGS.has(lower.slice(0, lower.indexOf('=')))) return false
      continue
    }
    if (arg.startsWith('-') && arg !== '-') {
      if (!GIT_REF_LIST_FLAGS.has(lower)) return false
      if (lower === '-l' || lower === '--list') explicitList = true
      if (GIT_REF_LIST_VALUE_FLAGS.has(lower)) index++
      continue
    }
    operands++
  }

  // Under `-l`/`--list` an operand is a glob to filter by; without one it names
  // a ref to create.
  return operands === 0 || explicitList
}

function isReadOnlyDocker(args: string[]): boolean {
  const subcommand = args.find((arg) => !arg.startsWith('-'))?.toLowerCase()
  return subcommand !== undefined && READ_ONLY_DOCKER_SUBCOMMANDS.has(subcommand)
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

function isReadOnlySed(args: string[]): boolean {
  const sed = parseSedInvocation(args)
  if (!sed || sed.inPlace || sed.usesScriptFile) return false
  return sed.scripts.every((script) => !hasDangerousSedScript(script))
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
