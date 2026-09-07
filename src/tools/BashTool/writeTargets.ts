import path from 'node:path'
import { homedir } from 'node:os'
import { splitShellSegments, shellWords } from '../../harness/bashSafety.js'

/**
 * Paths a bash command is about to write, for file history.
 *
 * Unlike the permission layer this is not a safety check: missing a path costs
 * a `/rewind` entry, never correctness, so the rule is "only high-confidence
 * forms". Anything with a glob, a variable, or a command substitution in the
 * target is dropped rather than guessed at — expanding those needs the shell
 * itself, and a wrong guess would back up a file nobody touched.
 *
 * Over-inclusion is the cheap direction: a path that never gets written has an
 * unchanged backup and drops out of the diff. Under-inclusion silently leaves
 * a file unprotected.
 */

/**
 * `>` and `>>`, plus their fd-qualified (`2>`) and `&>` spellings.
 *
 * The target must be whitespace-free because `shellWords` has already dropped
 * the quotes: a word reading `> not-a-file` can only have come from a quoted
 * argument, never from a real redirection, which `shellWords` would have split.
 * `>|` never reaches here — `splitShellSegments` cuts on the pipe first.
 */
const REDIRECT = /^&?[0-9]*(>>|>)(\S*)$/

/** Destinations that are devices, not files. */
const DEVICE_TARGETS = new Set(['/dev/null', '/dev/stdout', '/dev/stderr', '/dev/tty', '/dev/fd'])

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

/** Cheap globs/expansions we refuse to guess at. */
const UNRESOLVABLE = /[*?$`]|\[.*\]/

/**
 * Absolute paths a command will write. Best effort: never throws, and an
 * unparseable command simply yields nothing.
 */
export function extractBashWritePaths(command: string, cwd: string): string[] {
  const found = new Set<string>()
  try {
    for (const segment of splitShellSegments(command)) {
      for (const target of segmentWriteTargets(segment)) {
        const resolved = resolveTarget(target, cwd)
        if (resolved) found.add(resolved)
      }
    }
  } catch {
    // ignored: tracking is optional, the command still runs
  }
  return [...found]
}

function segmentWriteTargets(segment: string): string[] {
  const words = shellWords(segment)
  const targets: string[] = []
  const operands: string[] = []
  let commandName: string | undefined
  let recursive = false
  let endOfFlags = false

  for (let i = 0; i < words.length; i++) {
    const word = words[i]!

    const redirect = word.match(REDIRECT)
    if (redirect) {
      // `> out.txt` puts the target in the next word; `>out.txt` in this one.
      const inline = redirect[2]!
      const target = inline || words[++i]
      // `2>&1` duplicates a descriptor, it does not name a file.
      if (target && !target.startsWith('&')) targets.push(target)
      continue
    }

    if (commandName === undefined) {
      if (ASSIGNMENT.test(word)) continue
      commandName = path.basename(word.replace(/\\/g, '/')).toLowerCase()
      continue
    }

    if (!endOfFlags && word === '--') {
      endOfFlags = true
      continue
    }
    if (!endOfFlags && word.startsWith('-') && word !== '-') {
      if (isRecursiveFlag(word)) recursive = true
      continue
    }
    operands.push(word)
  }

  if (commandName === 'tee') {
    targets.push(...operands)
  } else if ((commandName === 'cp' || commandName === 'mv') && operands.length >= 2 && !recursive) {
    const destination = operands[operands.length - 1]!
    const sources = operands.slice(0, -1)
    targets.push(destination)
    // The destination may be a directory; naming both spellings costs nothing
    // because the one that does not exist never changes.
    for (const source of sources) {
      targets.push(path.posix.join(destination, path.basename(source.replace(/\\/g, '/'))))
    }
    // `mv` removes its sources, so those need a backup too.
    if (commandName === 'mv') targets.push(...sources)
  }

  return targets
}

function isRecursiveFlag(word: string): boolean {
  if (word.startsWith('--')) return word === '--recursive' || word === '--archive'
  return /[raR]/.test(word.slice(1))
}

function resolveTarget(target: string, cwd: string): string | undefined {
  const trimmed = target.trim()
  if (!trimmed || trimmed === '-') return undefined
  if (UNRESOLVABLE.test(trimmed)) return undefined
  if (DEVICE_TARGETS.has(trimmed) || trimmed.startsWith('/dev/')) return undefined
  const expanded = trimmed === '~' || trimmed.startsWith('~/') || trimmed.startsWith('~\\')
    ? path.join(homedir(), trimmed.slice(1))
    : trimmed
  return path.resolve(cwd, expanded)
}
