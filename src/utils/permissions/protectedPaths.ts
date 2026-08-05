/**
 * Directories whose contents are always protected. Match anywhere in the path.
 * Aligned with Claude Code's DANGEROUS_DIRECTORIES (isDangerousFilePathToAutoEdit);
 * `.myagent` is this project's equivalent of `.claude`.
 */
export const PROTECTED_PATHS = ['.git', '.vscode', '.idea', '.myagent'] as const

/**
 * Files whose exact basename is always protected.
 * Aligned with Claude Code's DANGEROUS_FILES; `.myagent.json` is this
 * project's equivalent of `.claude.json`.
 */
export const PROTECTED_FILES = [
  '.gitconfig',
  '.gitmodules',
  '.bashrc',
  '.bash_profile',
  '.zshrc',
  '.zprofile',
  '.profile',
  '.ripgreprc',
  '.mcp.json',
  '.myagent.json',
] as const

/**
 * Glob patterns matched against the basename of the path.
 * Empty by design: secret-file patterns are intentionally not bypass-immune.
 */
export const PROTECTED_FILE_PATTERNS: RegExp[] = []

/**
 * Path suffixes (directory + filename) that are always protected even though
 * neither component alone is in PROTECTED_PATHS or PROTECTED_FILES with the
 * required precision. Empty by design (aligned with Claude Code).
 */
export const PROTECTED_PATH_SUFFIXES = [] as const

export function basenameOf(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  const trimmed = normalized.replace(/\/+$/, '')
  const slash = trimmed.lastIndexOf('/')
  return slash === -1 ? trimmed : trimmed.slice(slash + 1)
}

export function containsProtectedPath(content: string): boolean {
  const normalized = content.replace(/\\/g, '/').toLowerCase()
  const matchesLiteral = [
    ...PROTECTED_PATHS,
    ...PROTECTED_FILES,
    ...PROTECTED_PATH_SUFFIXES,
  ].some((path) => {
    return normalized === path
      || normalized.startsWith(`${path}/`)
      || normalized.includes(`/${path}/`)
      || normalized.includes(` ${path}/`)
      || normalized.includes(`=${path}/`)
      || normalized.endsWith(`/${path}`)
      || normalized.endsWith(` ${path}`)
      || normalized.includes(`"${path}/`)
      || normalized.includes(`'${path}/`)
      || normalized.endsWith(` ${path.replace(/.*\//, '')}`)
      || normalized.endsWith(`/${path.replace(/.*\//, '')}`)
  })
  if (matchesLiteral) return true

  // Tokenize and check each token's basename against secret-file patterns.
  const tokens = normalized.split(/[\s"'`=]+/).filter(Boolean)
  return tokens.some((token) => {
    const stripped = token.replace(/^[~.]?\/+/, '').replace(/\/+$/, '')
    const base = stripped.includes('/') ? stripped.slice(stripped.lastIndexOf('/') + 1) : stripped
    if (!base) return false
    return PROTECTED_FILE_PATTERNS.some((re) => re.test(base))
  })
}

export function isProtectedPath(path: string): boolean {
  if (!path) return false
  const normalized = path.replace(/\\/g, '/')
  const lower = normalized.toLowerCase()

  if (containsProtectedPath(normalized)) return true

  if (PROTECTED_PATHS.some((p) => lower.includes(`/${p}/`) || lower.endsWith(`/${p}`) || lower === p || lower.startsWith(`${p}/`))) {
    return true
  }

  if (PROTECTED_PATH_SUFFIXES.some((suffix) => lower.endsWith(`/${suffix}`) || lower.endsWith(suffix) || lower === suffix)) {
    return true
  }

  const base = basenameOf(lower)
  if (PROTECTED_FILES.includes(base as (typeof PROTECTED_FILES)[number])) return true
  if (PROTECTED_FILE_PATTERNS.some((re) => re.test(base))) return true

  return false
}

const DOS_DEVICE_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i
const SHORT_NAME_PATTERN = /~[1-9](\.[^.]*)?$/
const NTFS_ADS_PATTERN = /:[^/\\:*?"<>|]+(:\$DATA)?$/i

export interface WindowsPathSafetyResult {
  suspicious: boolean
  reason?: string
}

export function checkWindowsPathSafety(path: string): WindowsPathSafetyResult {
  if (!path) return { suspicious: false }

  if (path.startsWith('\\\\?\\') || path.startsWith('//?/')) {
    return { suspicious: true, reason: 'Extended-length path prefix (\\\\?\\) can bypass path normalization' }
  }

  if (path.startsWith('\\\\') || path.startsWith('//')) {
    const withoutPrefix = path.replace(/^[\\/]{2}/, '')
    if (!withoutPrefix.startsWith('?')) {
      return { suspicious: true, reason: 'UNC paths may leak credentials to remote hosts' }
    }
  }

  const segments = path.split(/[/\\]/).filter(Boolean)
  for (const segment of segments) {
    if (DOS_DEVICE_NAMES.test(segment)) {
      return { suspicious: true, reason: `DOS device name "${segment}" can cause unexpected I/O behavior` }
    }
    if (segment.endsWith('.') || segment.endsWith(' ')) {
      return { suspicious: true, reason: `Path component "${segment}" has trailing dot/space (Windows normalizes these away)` }
    }
    if (SHORT_NAME_PATTERN.test(segment) && segment.includes('~')) {
      return { suspicious: true, reason: `8.3 short name "${segment}" may resolve to a different target than expected` }
    }
    if (NTFS_ADS_PATTERN.test(segment)) {
      return { suspicious: true, reason: `NTFS Alternate Data Stream in "${segment}" can hide or redirect content` }
    }
  }

  return { suspicious: false }
}
