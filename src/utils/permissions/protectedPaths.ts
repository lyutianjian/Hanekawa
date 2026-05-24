/**
 * Directories whose contents are always protected. Match anywhere in the path.
 */
export const PROTECTED_PATHS = ['.git', '.myagent', '.env', '.ssh', '.aws'] as const

/**
 * Files whose exact basename is always protected.
 */
export const PROTECTED_FILES = [
  '.gitconfig',
  '.bashrc',
  '.zshrc',
  '.env',
  '.npmrc',
  'credentials.json',
  'secrets.yaml',
  'secrets.yml',
] as const

/**
 * Glob patterns matched against the basename of the path.
 * Covers SSH/TLS private keys and PKCS#12 bundles.
 */
export const PROTECTED_FILE_PATTERNS: RegExp[] = [
  /^id_rsa(\..*)?$/i,
  /^id_dsa(\..*)?$/i,
  /^id_ecdsa(\..*)?$/i,
  /^id_ed25519(\..*)?$/i,
  /\.pem$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /\.key$/i,
]

/**
 * Path suffixes (directory + filename) that are always protected even though
 * neither component alone is in PROTECTED_PATHS or PROTECTED_FILES with the
 * required precision. `.aws/credentials` is the canonical example.
 */
export const PROTECTED_PATH_SUFFIXES = [
  '.aws/credentials',
  '.aws/config',
  '.config/gcloud/credentials.db',
] as const

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
