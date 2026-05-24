import { analyzeBashSafety, shellWords } from './bashSafety.js'
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
  categories: string[]
}

export function analyzeShellCommand(command: string): CommandAnalysis {
  const safety = analyzeBashSafety(command)
  const segments = safety.segments
  const categories = new Set<string>()
  const lower = command.toLowerCase()

  if (SHELL_OPERATORS.test(command) || REDIRECTION.test(command)) {
    categories.add('complex shell command')
  }

  if (isDestructive(lower)) {
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
    categories: [...categories],
  }
}

function isDestructive(command: string): boolean {
  if (hasRecursiveForceRm(command)) return true
  if (hasWriteLikeReadCommandFlags(command)) return true

  return [
    /(^|\s)git\s+reset\s+--hard\b/,
    /(^|\s)git\s+clean\s+[^;&|]*-[^\s]*f\b/,
    /(^|\s)git\s+checkout\b[^;&|]*\s--\s+/,
    /(^|\s)(del|erase|rmdir|rd)\b/,
  ].some((pattern) => pattern.test(command))
}

function hasRecursiveForceRm(command: string): boolean {
  for (const segment of analyzeBashSafety(command).segments) {
    const words = shellWords(segment)
    if (words.length === 0) continue
    const executable = basename(words[0]!).toLowerCase()
    if (executable !== 'rm') continue

    let hasRecursive = false
    let hasForce = false
    for (const word of words.slice(1)) {
      const lower = word.toLowerCase()
      if (lower === '--') break
      if (lower === '--recursive') hasRecursive = true
      if (lower === '--force') hasForce = true
      if (lower.startsWith('--')) continue
      if (!lower.startsWith('-')) continue
      if (lower.includes('r') || lower.includes('R'.toLowerCase())) hasRecursive = true
      if (lower.includes('f')) hasForce = true
    }

    if (hasRecursive && hasForce) return true
  }
  return false
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
