import { analyzeShellCommand, normalizedExecutable } from './commandAnalysis.js'
import { shellWords } from './bashSafety.js'

/**
 * Permission rule matching for shell (Bash) commands, ported from Claude
 * Code's shellRuleMatching.ts / bashPermissions.ts. Supports three match
 * modes — exact, prefix (legacy `cmd:*`), and wildcard (`cmd *`) — with
 * word-boundary enforcement, compound-command guards, and asymmetric
 * normalization (deny/ask rules strip all env vars; allow rules strip only
 * a safe whitelist) so a denied command stays denied regardless of prefixes.
 */

/** Prefixes that would auto-approve arbitrary/privileged commands if suggested. */
const BARE_SHELL_PREFIXES = new Set([
  'sh', 'bash', 'zsh', 'fish', 'csh', 'tcsh', 'ksh', 'dash',
  'cmd', 'powershell', 'pwsh',
  'env', 'xargs', 'nice', 'stdbuf', 'nohup', 'timeout', 'time',
  'sudo', 'doas', 'pkexec',
  'cd',
])

/**
 * Suggest a prefix rule for a Bash command segment: executable + first
 * non-flag operand (`git commit -m x` -> `git commit`). Returns undefined
 * for bare shells, privilege wrappers, and operands with shell metacharacters.
 */
export function suggestBashPrefix(segment: string): string | undefined {
  const words = shellWords(segment)
  if (words.length === 0) return undefined
  let index = 0
  while (index < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index]!)) index++
  if (index >= words.length) return undefined
  const executable = normalizedExecutable(words[index]!)
  if (BARE_SHELL_PREFIXES.has(executable)) return undefined
  const args = words.slice(index + 1)
  // shellWords does not split on operators, so `git commit a&rm -rf x` puts
  // `&` in a later arg; a `git commit:*` prefix would absorb the second
  // command. Reject any arg (flag values included) that could smuggle one.
  if (args.some((word) => /[\r\n\0*?[\]{}$`~&|;<>()!#]/.test(word))) return undefined
  const firstOperand = args.find((word) => !word.startsWith('-'))
  return firstOperand ? `${executable} ${firstOperand}` : executable
}

export type ShellPermissionRule =
  | { type: 'exact'; command: string }
  | { type: 'prefix'; prefix: string }
  | { type: 'wildcard'; pattern: string }

const ESCAPED_STAR = '\x00STAR\x00'
const ESCAPED_STAR_RE = new RegExp(ESCAPED_STAR, 'g')

/** Detect unescaped `*` (not the legacy `:*` prefix suffix). */
function hasWildcards(pattern: string): boolean {
  if (pattern.endsWith(':*')) return false
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] !== '*') continue
    let backslashes = 0
    for (let j = i - 1; j >= 0 && pattern[j] === '\\'; j--) backslashes++
    if (backslashes % 2 === 0) return true
  }
  return false
}

export function parseShellRule(pattern: string): ShellPermissionRule {
  const prefixMatch = pattern.match(/^(.+):\*$/)
  if (prefixMatch) return { type: 'prefix', prefix: prefixMatch[1]! }
  if (hasWildcards(pattern)) return { type: 'wildcard', pattern }
  return { type: 'exact', command: pattern }
}

/**
 * Match a command against a wildcard pattern. `*` matches any run of
 * characters; `\*` matches a literal asterisk. A pattern ending in ` *`
 * with a single wildcard also matches the bare prefix (`git *` matches
 * `git`), aligning wildcard semantics with prefix rules.
 */
export function matchWildcardPattern(pattern: string, command: string, caseInsensitive = false): boolean {
  const trimmed = pattern.trim()
  let processed = ''
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i]!
    if (ch === '\\' && trimmed[i + 1] === '*') {
      processed += ESCAPED_STAR
      i++
      continue
    }
    processed += ch
  }
  const escaped = processed.replace(/[.+?^${}()|[\]\\'"]/g, '\\$&').replace(/\*/g, '.*')
  let regexSrc = escaped.replace(ESCAPED_STAR_RE, '\\*')
  const starCount = (processed.match(/\*/g) ?? []).length
  if (regexSrc.endsWith(' .*') && starCount === 1) {
    regexSrc = regexSrc.slice(0, -3) + '( .*)?'
  }
  return new RegExp(`^${regexSrc}$`, 's' + (caseInsensitive ? 'i' : '')).test(command)
}

const ENV_VAR_SAFE = /^([A-Za-z_][A-Za-z0-9_]*)=([A-Za-z0-9_./:-]+)[ \t]+/
const ENV_VAR_ALL = /^([A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?)\+?=(?:'[^'\n\r]*'|"(?:\\.|[^"$`\\\n\r])*"|\\.|[^ \t\n\r$`;|&()<>\\'"])*[ \t]+/

/** Whitelist of env vars that cannot execute code or load libraries. */
const SAFE_ENV_VARS = new Set([
  'GOOS', 'GOARCH', 'CGO_ENABLED', 'GO111MODULE', 'GOEXPERIMENT',
  'RUST_BACKTRACE', 'RUST_LOG', 'NODE_ENV',
  'PYTHONUNBUFFERED', 'PYTHONDONTWRITEBYTECODE',
  'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'LC_TIME', 'CHARSET',
  'TERM', 'COLORTERM', 'NO_COLOR', 'FORCE_COLOR', 'TZ',
  'LS_COLORS', 'LSCOLORS', 'GREP_COLOR', 'GREP_COLORS', 'GCC_COLORS',
  'TIME_STYLE', 'BLOCK_SIZE', 'BLOCKSIZE',
])

function stripCommentLines(command: string): string {
  return command.replace(/^[ \t]*#[^\n]*\n?/gm, '').trimStart()
}

/**
 * Strip safe wrapper commands (timeout/time/nice/nohup/stdbuf) and
 * whitelisted env var prefixes. Phase 1 strips whitelisted env vars only;
 * phase 2 strips wrappers only — wrappers run their args via execvp, so a
 * `VAR=val` after a wrapper is the command, not an assignment (HackerOne #3543050).
 */
export function stripSafeWrappers(command: string): string {
  const wrappers = [
    /^timeout[ \t]+(?:(?:--(?:foreground|preserve-status|verbose)|--(?:kill-after|signal)=[A-Za-z0-9_.+-]+|--(?:kill-after|signal)[ \t]+[A-Za-z0-9_.+-]+|-v|-[ks][ \t]+[A-Za-z0-9_.+-]+|-[ks][A-Za-z0-9_.+-]+)[ \t]+)*(?:--[ \t]+)?\d+(?:\.\d+)?[smhd]?[ \t]+/,
    /^time[ \t]+(?:--[ \t]+)?/,
    /^nice(?:[ \t]+-n[ \t]+-?\d+|[ \t]+-\d+)?[ \t]+(?:--[ \t]+)?/,
    /^stdbuf(?:[ \t]+-[ioe][LN0-9]+)+[ \t]+(?:--[ \t]+)?/,
    /^nohup[ \t]+(?:--[ \t]+)?/,
  ] as const

  let stripped = command
  let prev = ''
  while (stripped !== prev) {
    prev = stripped
    stripped = stripCommentLines(stripped)
    const m = stripped.match(ENV_VAR_SAFE)
    if (m && SAFE_ENV_VARS.has(m[1]!)) stripped = stripped.replace(ENV_VAR_SAFE, '')
  }

  prev = ''
  while (stripped !== prev) {
    prev = stripped
    stripped = stripCommentLines(stripped)
    for (const pattern of wrappers) stripped = stripped.replace(pattern, '')
  }

  return stripped.trim()
}

/** Strip ALL leading env var prefixes (quoted/unquoted/array). For deny/ask only. */
export function stripAllLeadingEnvVars(command: string): string {
  let stripped = command
  let prev = ''
  while (stripped !== prev) {
    prev = stripped
    stripped = stripCommentLines(stripped)
    const m = stripped.match(ENV_VAR_ALL)
    if (!m) continue
    stripped = stripped.slice(m[0].length)
  }
  return stripped.trim()
}

/** Remove output redirections (`> f`, `>> f`, `2>&1`, `< f`) for rule matching. */
function stripOutputRedirections(command: string): string {
  return command
    .replace(/[ \t]+(?:\d+)?>>?&?\d*\s+[^\s;|&]+/g, '')
    .replace(/[ \t]+<\s+[^\s;|&]+/g, '')
    .replace(/[ \t]+(?:\d)?>>?&\d+/g, '')
    .trim()
}

const COMPOUND_OPERATOR = /&&|\|\||[;|\n]/

function isCompound(command: string): boolean {
  return COMPOUND_OPERATOR.test(command)
}

export interface BashMatchOptions {
  /** Deny/ask rules strip all env var prefixes; allow rules strip only the whitelist. */
  stripAllEnvVars?: boolean
  /** Deny/ask rules match compound commands; allow prefix/wildcard rules do not. */
  skipCompoundCheck?: boolean
}

/**
 * Match a Bash permission rule pattern against a set of command candidates
 * (typically the whole command plus each subcommand segment). Returns true
 * if any candidate matches under the rule's semantics.
 */
export function matchBashRule(
  rulePattern: string,
  candidates: string[],
  options: BashMatchOptions = {},
): boolean {
  const parsed = parseShellRule(rulePattern)
  const { stripAllEnvVars = false, skipCompoundCheck = false } = options

  for (const candidate of candidates) {
    const withoutRedirect = stripOutputRedirections(candidate)
    const wrapped = stripSafeWrappers(withoutRedirect)
    const variants = [candidate, withoutRedirect, wrapped]
    if (stripAllEnvVars) {
      variants.push(stripAllLeadingEnvVars(wrapped))
    }
    const unique = [...new Set(variants.filter((v) => v !== ''))]

    for (const variant of unique) {
      if (parsed.type === 'exact') {
        if (variant === parsed.command) return true
      } else if (parsed.type === 'prefix') {
        if (!skipCompoundCheck && isCompound(variant)) continue
        if (variant === parsed.prefix || variant.startsWith(parsed.prefix + ' ')) return true
        const xargs = 'xargs ' + parsed.prefix
        if (variant === xargs || variant.startsWith(xargs + ' ')) return true
      } else {
        if (!skipCompoundCheck && isCompound(variant)) continue
        if (matchWildcardPattern(parsed.pattern, variant)) return true
      }
    }
  }
  return false
}

/** Split a command into subcommand segments for per-segment rule matching. */
export function bashCommandSegments(command: string): string[] {
  return analyzeShellCommand(command).segments
}
