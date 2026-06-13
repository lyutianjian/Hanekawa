/**
 * Auto mode classifier -- extracted from PermissionGate for testability.
 *
 * Decision layers (fastest to slowest):
 *  1. SAFE_AUTO_TOOLS  -- read-only / metadata tools skip the classifier entirely
 *  2. acceptEdits fast-path (in PermissionGate) -- CWD file ops skip the classifier
 *  3. User-configured allow/deny rules from settings.autoMode
 *  4. Base rule-based classifier (read-only commands, validation, light writes,
 *     non-destructive confirm tools)
 */

import { shellWords } from './bashSafety.js'
import type { CommandAnalysis } from './commandAnalysis.js'
import type { Tool } from './types.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AutoDecision =
  | { action: 'allow' }
  | { action: 'prompt'; reason: string; source: 'mode' }
  | { action: 'deny'; source: 'mode' }

export interface AutoModeConfig {
  allow?: string[]
  deny?: string[]
}

// ---------------------------------------------------------------------------
// Safe-tool allowlist -- these skip the classifier entirely
// ---------------------------------------------------------------------------

/**
 * Tools considered inherently safe for auto mode. They are read-only or
 * metadata-only and never mutate external state.
 */
export const SAFE_AUTO_TOOLS = new Set([
  'Read',
  'Grep',
  'Glob',
  'ToolSearch',
  'AskUserQuestion',
  'EnterPlanMode',
  'ExitPlanMode',
  'TaskCreate',
  'TaskGet',
  'TaskUpdate',
  'TaskList',
  'TaskStop',
  'TaskOutput',
  'webSearch',
  'webFetch',
  'Config',
  'Skill',
])

export function isSafeAutoTool(toolName: string): boolean {
  return SAFE_AUTO_TOOLS.has(toolName)
}

// ---------------------------------------------------------------------------
// Read-only shell commands (shared with plan mode)
// ---------------------------------------------------------------------------

const PLAN_READ_ONLY_SHELL_COMMANDS = new Set([
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
  'select-string',
  'stat',
  'tail',
  'wc',
])

const PLAN_READ_ONLY_GIT_SUBCOMMANDS = new Set([
  'diff',
  'grep',
  'log',
  'ls-files',
  'rev-parse',
  'shortlog',
  'show',
  'show-ref',
  'status',
  'tag',
])

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function basename(command: string): string {
  const normalized = command.replace(/\\/g, '/')
  const slash = normalized.lastIndexOf('/')
  return slash === -1 ? normalized : normalized.slice(slash + 1)
}

export function isPlanReadOnlyShellCommand(command: string): boolean {
  const words = shellWords(command)
  if (words.length === 0) return false
  const executable = basename(words[0]!).toLowerCase()
  if (executable === 'git') {
    const subcommand = words.find((word, index) => index > 0 && !word.startsWith('-'))
    return typeof subcommand === 'string' && PLAN_READ_ONLY_GIT_SUBCOMMANDS.has(subcommand.toLowerCase())
  }
  if (!PLAN_READ_ONLY_SHELL_COMMANDS.has(executable)) return false
  if (executable === 'fd') {
    return !words.slice(1).some((word) => {
      const lower = word.toLowerCase()
      return lower === '--exec' || lower === '--exec-batch' || /^-[a-z]*x[a-z]*$/.test(lower)
    })
  }
  if (executable === 'find') {
    return !words.slice(1).some((word) => {
      const lower = word.toLowerCase()
      return lower === '-delete' || lower === '-exec' || lower === '-execdir'
    })
  }
  return PLAN_READ_ONLY_SHELL_COMMANDS.has(executable)
}

function isValidationScriptName(script: string): boolean {
  return script === 'test' || script === 'typecheck' || script === 'lint'
}

export function isValidationShellCommand(
  command: string,
  commandAnalysis: CommandAnalysis,
): boolean {
  if (commandAnalysis.categories.length > 0) return false
  if (commandAnalysis.hasSafetyDenyIssue || commandAnalysis.requiresSafetyPrompt || commandAnalysis.hasProtectedPath) return false
  if (commandAnalysis.segments.length !== 1) return false

  const words = shellWords(command)
  if (words.length === 0) return false
  const executable = basename(words[0]!).toLowerCase()
  const args = words.slice(1).map((word) => word.toLowerCase())

  if (executable === 'npm') {
    if (args.length === 1 && args[0] === 'test') return true
    return args.length === 2 && args[0] === 'run' && isValidationScriptName(args[1]!)
  }

  if (executable === 'bun') {
    if (args.length === 1 && args[0] === 'test') return true
    return args.length === 2 && args[0] === 'run' && isValidationScriptName(args[1]!)
  }

  if (executable === 'tsc') {
    return args.length === 1 && args[0] === '--noemit'
  }

  if (executable === 'node') {
    return args.length === 1 && args[0] === '--test'
  }

  return false
}

// ---------------------------------------------------------------------------
// Base rule-based classifier
// ---------------------------------------------------------------------------

/**
 * Core classification logic. Evaluates a tool call against the built-in
 * allowlists and returns an AutoDecision.
 */
export function classifyAutoDecision(params: {
  tool: Tool
  input: unknown
  commandAnalysis: CommandAnalysis | undefined
  isLightWorkspaceShellWrite: (commandAnalysis: CommandAnalysis) => boolean
}): AutoDecision {
  const { tool, commandAnalysis, isLightWorkspaceShellWrite } = params

  if (tool.name === 'Bash') {
    if (!commandAnalysis) {
      return {
        action: 'prompt',
        reason: 'Auto mode requires confirmation because this Bash command could not be analyzed.',
        source: 'mode',
      }
    }
    if (isPlanReadOnlyShellCommand(commandAnalysis.command)) return { action: 'allow' }
    if (isValidationShellCommand(commandAnalysis.command, commandAnalysis)) return { action: 'allow' }
    if (isLightWorkspaceShellWrite(commandAnalysis)) return { action: 'allow' }

    const categories = commandAnalysis.categories.length > 0
      ? commandAnalysis.categories.join(', ')
      : 'the command is not in the auto-mode allowlist'
    return {
      action: 'prompt',
      reason: `Auto mode requires confirmation because ${categories}.`,
      source: 'mode',
    }
  }

  if (tool.riskLevel === 'confirm' && tool.isDestructive !== true) return { action: 'allow' }

  return {
    action: 'prompt',
    reason: tool.isDestructive === true || tool.riskLevel === 'dangerous'
      ? 'Auto mode requires confirmation because this is a dangerous or destructive tool.'
      : 'Auto mode requires confirmation because this tool is not in the auto-mode allowlist.',
    source: 'mode',
  }
}

// ---------------------------------------------------------------------------
// User-configurable rules wrapper
// ---------------------------------------------------------------------------

/**
 * Wraps the base classifier with user-configured allow/deny rules from
 * settings.autoMode. Deny rules are checked first (deny wins over allow).
 */
export function classifyWithUserRules(params: {
  tool: Tool
  input: unknown
  commandAnalysis: CommandAnalysis | undefined
  autoModeConfig?: AutoModeConfig
  isLightWorkspaceShellWrite: (commandAnalysis: CommandAnalysis) => boolean
  matchGlob: (content: string, pattern: string) => boolean
  extractPath: (input: unknown) => string
}): AutoDecision {
  const { tool, input, commandAnalysis, autoModeConfig, matchGlob, extractPath, isLightWorkspaceShellWrite } = params

  // Check user-configured rules first
  if (autoModeConfig) {
    const content = extractPath(input) || (typeof input === 'string' ? input : JSON.stringify(input))

    // Deny rules take precedence
    if (autoModeConfig.deny) {
      for (const entry of autoModeConfig.deny) {
        if (matchesUserRule(entry, tool.name, content, matchGlob)) {
          return { action: 'deny', source: 'mode' }
        }
      }
    }

    // Allow rules
    if (autoModeConfig.allow) {
      for (const entry of autoModeConfig.allow) {
        if (matchesUserRule(entry, tool.name, content, matchGlob)) {
          return { action: 'allow' }
        }
      }
    }
  }

  // Fall through to base classifier
  return classifyAutoDecision({ tool, input, commandAnalysis, isLightWorkspaceShellWrite })
}

/**
 * Check if a user rule entry matches the current tool call.
 * Format: "ToolName" or "ToolName:contentPattern"
 */
function matchesUserRule(
  entry: string,
  toolName: string,
  content: string,
  matchGlob: (content: string, pattern: string) => boolean,
): boolean {
  const trimmed = entry.trim()
  if (!trimmed) return false
  const colon = trimmed.indexOf(':')
  if (colon > 0) {
    const ruleTool = trimmed.slice(0, colon).trim()
    const pattern = trimmed.slice(colon + 1).trim()
    if (ruleTool !== toolName) return false
    if (!pattern) return true
    if (content === pattern) return true
    return matchGlob(content, pattern)
  }
  return trimmed === toolName
}
