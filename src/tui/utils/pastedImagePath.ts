import path from 'node:path'
import { IMAGE_FILE_EXTENSIONS } from '../../tools/imageFile.js'

/**
 * Standalone-path recognition for terminal pastes (design doc §6.2, session
 * S14 work item 1).
 *
 * Dropping a file into a terminal hands the shell a path as text — quoted,
 * backslash-escaped, or bare. This module decides, purely from the pasted
 * string, whether the paste is *nothing but* one fully parseable image path.
 * Everything else — sentences, code blocks, long text that happens to contain
 * a path — keeps its text semantics.
 *
 * Nothing here touches a shell: the pasted string is never executed, and the
 * caller resolves the cleaned path with `node:fs` directly.
 */

export interface PastedImagePath {
  /** The pasted path with quotes and platform escapes removed; not yet resolved or verified on disk. */
  path: string
}

/** Longest paste we are willing to examine; real paths stay far below this. */
const MAX_PASTED_PATH_LENGTH = 4096

/** Escapes POSIX terminals emit when dropping a path with spaces: `\ `, `\"`, `\'`, `\\`. */
const POSIX_ESCAPE_CHARS = new Set([' ', '"', "'", '\\'])

const CONTROL_CHARS = /[\x00-\x1f\x7f]/

/**
 * Parse a paste that may be a standalone image path. Returns the cleaned path
 * when the *whole* paste is one image-file path candidate, or `null` when it
 * is anything else (then the caller inserts it as plain text).
 *
 * `platform` decides how backslashes read: on Windows they are path
 * separators and never escapes; elsewhere `\x` sequences from a terminal
 * file-drop are unescaped before the whitespace check.
 */
export function parseStandaloneImagePath(
  pasted: string,
  options: { platform?: NodeJS.Platform } = {},
): PastedImagePath | null {
  const platform = options.platform ?? process.platform
  const raw = pasted.trim()
  if (raw === '' || raw.length > MAX_PASTED_PATH_LENGTH) return null

  let cleaned: string
  if (isWrappedInQuotes(raw)) {
    cleaned = raw.slice(1, -1)
    // A quote inside the quoted span means the quotes were part of the text,
    // not a wrapper around one path. Spaces are fine — that is what the
    // quotes were for.
    if (cleaned === '' || cleaned.includes('"') || cleaned.includes("'")) return null
  } else {
    if (raw.includes('"') || raw.includes("'")) return null
    if (platform === 'win32') {
      // Backslashes are separators, never escapes; an unquoted path with
      // spaces is not a complete path paste.
      if (/\s/.test(raw)) return null
      cleaned = raw
    } else {
      // Whitespace that no backslash escaped means the paste held more than
      // one path-shaped word — it stays text. The check runs on the raw
      // paste, where escaped and bare spaces are still distinguishable.
      if (hasUnescapedWhitespace(raw)) return null
      cleaned = unescapePosixPath(raw)
    }
  }

  if (CONTROL_CHARS.test(cleaned)) return null

  // A bare `photo.png` is too ambiguous to steal from the composer: real
  // file-drops are anchored (absolute, `~`, or carry a directory separator).
  if (!cleaned.includes('/') && !cleaned.includes('\\')) return null

  if (!hasImageExtension(cleaned)) return null

  return { path: cleaned }
}

function isWrappedInQuotes(raw: string): boolean {
  return raw.length >= 2
    && ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'")))
}

/** Merge `\x` escapes for the characters POSIX file-drops escape; other backslashes are literal. */
function unescapePosixPath(raw: string): string {
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const char = raw[i]!
    if (char === '\\' && i + 1 < raw.length && POSIX_ESCAPE_CHARS.has(raw[i + 1]!)) {
      out += raw[i + 1]
      i++
      continue
    }
    out += char
  }
  return out
}

/** Whether any whitespace survives outside a `\x` escape — those are the words of a sentence, not one path. */
function hasUnescapedWhitespace(raw: string): boolean {
  for (let i = 0; i < raw.length; i++) {
    const char = raw[i]!
    if (char === '\\' && i + 1 < raw.length && POSIX_ESCAPE_CHARS.has(raw[i + 1]!)) {
      i++
      continue
    }
    if (/\s/.test(char)) return true
  }
  return false
}

function hasImageExtension(cleaned: string): boolean {
  const separatorIndex = Math.max(cleaned.lastIndexOf('/'), cleaned.lastIndexOf('\\'))
  const fileName = cleaned.slice(separatorIndex + 1)
  const dotIndex = fileName.lastIndexOf('.')
  if (dotIndex <= 0 || dotIndex === fileName.length - 1) return false
  return IMAGE_FILE_EXTENSIONS.has(fileName.slice(dotIndex).toLowerCase())
}

/** Expands a leading `~` to the user's home directory; everything else is returned as-is. */
export function expandHomePath(filePath: string, homedir: string): string {
  if (filePath === '~') return homedir
  if (filePath.startsWith('~/') || filePath.startsWith('~\\')) {
    return path.join(homedir, filePath.slice(2))
  }
  return filePath
}

/** Turns a cleaned pasted path into the absolute path the caller reads from disk. */
export function resolvePastedPath(
  cleanedPath: string,
  options: { cwd: string; homedir: string },
): string {
  return path.resolve(options.cwd, expandHomePath(cleanedPath, options.homedir))
}
