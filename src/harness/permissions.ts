import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import path from 'node:path'
import { homedir } from 'node:os'
import {
  analyzeShellCommand,
  isAcceptEditsSedSubstitution,
  parseSedInvocation,
  positionalArguments,
} from './commandAnalysis.js'
import { matchBashRule, bashCommandSegments, suggestBashPrefix } from './shellRuleMatching.js'
import { shellWords } from './bashSafety.js'
import type { RiskLevel, Tool, ToolApprovalRecord } from './types.js'
import { isProtectedPath, checkWindowsPathSafety, isDangerousRemovalPath } from '../utils/permissions/protectedPaths.js'
import { isPreapprovedUrl, matchesDomainRule, urlHostname } from '../utils/permissions/webFetchDomains.js'
import { getPlansDir } from '../utils/plans.js'

const require = createRequire(import.meta.url)
const picomatch = require('picomatch') as {
  isMatch(input: string, pattern: string, options?: { nocase?: boolean }): boolean
}

export type PermissionMode = 'default' | 'plan' | 'acceptEdits' | 'bypass' | 'readonly'

export interface PermissionRequest {
  tool: Tool
  input: unknown
  reason: string
  source: PermissionDecisionSource
  matchedRule?: PermissionRule
  alwaysAllowRule?: PermissionRule
  /**
   * Number of consecutive auto-denials of this tool that came before this
   * prompt. Surfaced so the dialog can warn the user that the model is
   * looping on a denied action. 0 means a normal prompt.
   */
  denialStreak: number
  onAlwaysAllow?: () => void
}

export type PermissionPrompt = (request: PermissionRequest) => Promise<boolean>
export type PermissionModeListener = (mode: PermissionMode) => void
export type PermissionDecisionSource =
  | 'mode'
  | 'allow rule'
  | 'ask rule'
  | 'deny rule'
  | 'protected path'
  | 'bash safety'

/**
 * The outcome of a permission check. `denialReason` is written for the model,
 * not the user: a denial the user never saw must not claim they made it, or
 * the model keeps retrying a call it thinks a human rejected.
 */
export interface PermissionDecision {
  approved: boolean
  source: PermissionDecisionSource | 'readonly mode'
  denialReason?: string
}

export interface DenialState {
  streaks: Record<string, number>
  total: number
}

export interface DenialStateStore {
  getDenialState(): Promise<DenialState>
  setDenialState(state: DenialState): Promise<void>
}

export interface PermissionRule {
  toolName: string
  contentPattern?: string
  behavior: 'allow' | 'deny' | 'ask'
  source: 'session' | 'config'
}

export interface PermissionSettings {
  allow?: string[]
  deny?: string[]
  ask?: string[]
}

/**
 * Default number of consecutive auto-denials of a tool after which we stop
 * silently denying and force a user prompt instead. Prevents a model from
 * looping on the exact same denied action.
 */
const DEFAULT_DENIAL_STREAK_THRESHOLD = 3
const DEFAULT_GLOBAL_DENIAL_PROMPT_THRESHOLD = 20
/**
 * `Delete` is included: `rm` is on the accept-edits shell allowlist below
 * (aligned with Claude Code's ACCEPT_EDITS_ALLOWED_COMMANDS), so excluding the
 * tool only pushed the model onto the shell for the same effect. Both paths
 * stay bounded by `isSafeWorkspacePathOperand` and the protected-path check.
 */
const ACCEPT_EDITS_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'Delete', 'NotebookEdit'])
const FILE_PERMISSION_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'Delete', 'NotebookEdit'])
const ACCEPT_EDITS_BASH_COMMANDS = new Set(['mkdir', 'touch', 'rm', 'rmdir', 'mv', 'cp', 'sed'])
/**
 * The one command category an accept-edits shell write may carry: `rm -rf x/`
 * and `sed -i` are destructive by definition, and refusing the category would
 * make the allowlist unreachable. Every other category — a compound, an
 * external side effect, unsafe syntax, a shell wrapper — still blocks.
 */
const ACCEPT_EDITS_ALLOWED_CATEGORY = 'destructive filesystem or git operation'
const WEB_FETCH_TOOL_NAME = 'WebFetch'
/** `WebFetch(domain:...)` rule content, aligned with Claude Code's syntax. */
const DOMAIN_RULE_PREFIX = 'domain:'

/**
 * Rule tool names that stand for a whole family (Claude Code §4.4): an
 * `Edit(...)` rule governs every write tool and a `Read(...)` rule every read
 * tool. A rule naming one concrete tool still matches that tool alone.
 */
const RULE_TOOL_ALIASES: Record<string, ReadonlySet<string>> = {
  Edit: new Set(['Edit', 'Write', 'MultiEdit', 'Delete', 'NotebookEdit']),
  Read: new Set(['Read', 'Grep', 'Glob']),
}

function ruleAppliesToTool(ruleToolName: string, toolName: string): boolean {
  if (ruleToolName === toolName) return true
  return RULE_TOOL_ALIASES[ruleToolName]?.has(toolName) ?? false
}

/** The URL a `WebFetch` call names, or '' when it names none. */
function extractUrl(input: unknown): string {
  if (input && typeof input === 'object') {
    const url = (input as { url?: unknown }).url
    if (typeof url === 'string') return url
  }
  return ''
}

/**
 * The tools whose permission is a *host* question, and how to find the host.
 *
 * `WebFetch` was the first and used to be hardcoded. `Browser` joins it because
 * the decision is the same one — this call is about to reach that site — even
 * though only two of its operations name a URL at all. The rest return '' and
 * a `domain:` rule simply does not match them, which is the correct answer: a
 * snapshot of a page already open is not a new host to approve.
 */
const HOST_SCOPED_TOOLS: Record<string, (input: unknown) => string> = {
  [WEB_FETCH_TOOL_NAME]: extractUrl,
  Browser: (input) => {
    if (!input || typeof input !== 'object') return ''
    const operation = (input as { operation?: unknown }).operation
    // Both operations that can start a navigation, not just `tab.navigate`:
    // `browser.create_tab` with a url performs the same act.
    if (operation !== 'tab.navigate' && operation !== 'browser.create_tab') return ''
    return extractUrl(input)
  },
}

function hostScopedUrl(toolName: string, input: unknown): string {
  return HOST_SCOPED_TOOLS[toolName]?.(input) ?? ''
}

export { isProtectedPath, checkWindowsPathSafety } from '../utils/permissions/protectedPaths.js'

export function permissionRulesFromSettings(permissions: PermissionSettings | undefined): PermissionRule[] {
  if (!permissions) return []
  return [
    ...permissionEntriesToRules(permissions.deny, 'deny'),
    ...permissionEntriesToRules(permissions.ask, 'ask'),
    ...permissionEntriesToRules(permissions.allow, 'allow'),
  ]
}

function permissionEntriesToRules(
  entries: string[] | undefined,
  behavior: PermissionRule['behavior'],
): PermissionRule[] {
  return (entries ?? []).flatMap((entry) => {
    const parsed = parsePermissionRuleEntry(entry)
    return parsed ? [{ ...parsed, behavior, source: 'config' as const }] : []
  })
}

function parsePermissionRuleEntry(entry: string): Pick<PermissionRule, 'toolName' | 'contentPattern'> | undefined {
  const trimmed = entry.trim()
  if (!trimmed) return undefined
  // Claude Code syntax: ToolName(content)
  const paren = trimmed.match(/^([A-Za-z0-9_-]+)\(([\s\S]*)\)$/)
  if (paren) {
    const content = paren[2]!.trim()
    return content ? { toolName: paren[1]!, contentPattern: content } : { toolName: paren[1]! }
  }
  // Legacy syntax: ToolName:pattern
  const colon = trimmed.indexOf(':')
  if (colon > 0) {
    const toolName = trimmed.slice(0, colon).trim()
    const contentPattern = trimmed.slice(colon + 1).trim()
    if (!toolName) return undefined
    return contentPattern ? { toolName, contentPattern } : { toolName }
  }
  return { toolName: trimmed }
}

function permissionRuleKey(rule: PermissionRule): string {
  return [
    rule.source,
    rule.behavior,
    rule.toolName,
    rule.contentPattern ?? '',
  ].join('\0')
}

/** Serialize a rule to its settings-file entry form, e.g. Bash(git commit:*). */
export function permissionRuleToEntry(rule: PermissionRule): string {
  return rule.contentPattern ? `${rule.toolName}(${rule.contentPattern})` : rule.toolName
}

function dedupePermissionRules(rules: PermissionRule[]): PermissionRule[] {
  const seen = new Set<string>()
  const deduped: PermissionRule[] = []
  for (const rule of rules) {
    const key = permissionRuleKey(rule)
    if (seen.has(key)) continue
    seen.add(key)
    deduped.push(rule)
  }
  return deduped
}

/**
 * The content a permission rule pattern is matched against. For Bash that is
 * the command string, which is why this is *not* a path — see `extractFilePath`
 * for the path-safety checks, which must never be handed a whole command.
 */
function extractRuleContent(input: unknown): string {
  if (typeof input === 'string') return input
  if (input && typeof input === 'object') {
    const obj = input as Record<string, unknown>
    if (typeof obj.path === 'string') return obj.path
    if (typeof obj.filePath === 'string') return obj.filePath
    if (typeof obj.notebook_path === 'string') return obj.notebook_path
    if (typeof obj.command === 'string') return obj.command
    if (typeof obj.url === 'string') return obj.url
  }
  return ''
}

/**
 * The file path a tool call names, or '' when it names none. Bash is excluded
 * deliberately: a command string run through path checks reports nonsense
 * (`echo "done."` looks like a path component with a trailing dot). Bash paths
 * come from the shell analysis instead.
 */
function extractFilePath(input: unknown): string {
  if (typeof input === 'string') return input
  if (input && typeof input === 'object') {
    const obj = input as Record<string, unknown>
    if (typeof obj.path === 'string') return obj.path
    if (typeof obj.filePath === 'string') return obj.filePath
    // `NotebookEdit` names its target `notebook_path` (see `inputAliases.ts`),
    // and without it a notebook write skipped every path check below.
    if (typeof obj.notebook_path === 'string') return obj.notebook_path
  }
  return ''
}

function approvedDecision(source: PermissionDecision['source']): PermissionDecision {
  return { approved: true, source }
}

/** A decision the user actually made at a prompt, so the denial may say so. */
function userDecision(approved: boolean, source: PermissionDecision['source'], tool: Tool): PermissionDecision {
  return approved
    ? { approved: true, source }
    : { approved: false, source, denialReason: `User denied permission for ${tool.name}.` }
}

function buildSessionAllowRule(
  tool: Tool,
  input: unknown,
  commandAnalysis: ReturnType<typeof analyzeShellCommand> | undefined,
): PermissionRule | undefined {
  if (tool.name === 'Bash') {
    if (!commandAnalysis) return undefined
    // `complex shell command` fires on any pipe, so refusing every categorized
    // command meant `git log | head` could never be allowed permanently. The
    // shared-prefix check below is what makes a compound safe to write a rule
    // for; the remaining categories are risks a rule must not paper over.
    if (commandAnalysis.categories.some((category) => category !== 'complex shell command')) return undefined
    if (commandAnalysis.hasSafetyDenyIssue || commandAnalysis.requiresSafetyPrompt || commandAnalysis.hasProtectedPath) {
      return undefined
    }
    // Every segment must suggest the identical prefix, otherwise a compound
    // like `git commit && git push` would yield a rule that over-approves.
    let shared: string | undefined
    for (const segment of commandAnalysis.segments) {
      const prefix = suggestBashPrefix(segment)
      if (!prefix) return undefined
      if (shared !== undefined && shared !== prefix) return undefined
      shared = prefix
    }
    if (shared === undefined) return undefined
    return { toolName: tool.name, contentPattern: `${shared}:*`, behavior: 'allow', source: 'session' }
  }

  if (tool.name in HOST_SCOPED_TOOLS) {
    // A host, not the exact URL: the next fetch of the same docs site is a
    // different page. Matches what the `WebFetch(domain:...)` rule expresses.
    // A call that names no URL yields no rule at all: "always allow" on a
    // snapshot must not quietly become a tool-wide allow for navigation too.
    const host = urlHostname(hostScopedUrl(tool.name, input))
    if (!host) return undefined
    return {
      toolName: tool.name,
      contentPattern: `${DOMAIN_RULE_PREFIX}${host}`,
      behavior: 'allow',
      source: 'session',
    }
  }

  if (FILE_PERMISSION_TOOLS.has(tool.name)) {
    const filePath = extractFilePath(input).trim()
    if (!filePath || isProtectedPath(filePath)) return undefined
    return { toolName: tool.name, contentPattern: filePath, behavior: 'allow', source: 'session' }
  }

  return { toolName: tool.name, behavior: 'allow', source: 'session' }
}

function matchGlob(content: string, pattern: string): boolean {
  // Use picomatch for safe, ReDoS-immune glob matching.
  return picomatch.isMatch(content, pattern, { nocase: true })
}

/**
 * Shared, deduped collection of session rules. Parent and subagent gates
 * reference the same store so an always-allow decision made in one is
 * immediately visible to the others.
 */
export interface SessionRuleStore {
  readonly rules: PermissionRule[]
  add(rule: PermissionRule): void
}

export function createSessionRuleStore(): SessionRuleStore {
  let rules: PermissionRule[] = []
  return {
    get rules() {
      return rules
    },
    add(rule) {
      const key = permissionRuleKey(rule)
      if (rules.some((r) => permissionRuleKey(r) === key)) return
      rules = [...rules, rule]
    },
  }
}

export class PermissionGate {
  private readonly sessionRuleStore: SessionRuleStore
  private configRules: PermissionRule[] = []
  private mode: PermissionMode
  private prePlanMode: PermissionMode = 'default'
  private planSlugProvider?: () => string | undefined
  /**
   * Per-tool consecutive auto-denial counter. Reset to 0 whenever a call to
   * that tool is approved. If an escalated prompt is denied, keep the counter
   * near the threshold so repeated requests keep involving the user instead
   * of dropping back to silent auto-denial.
   */
  private denialStreaks = new Map<string, number>()
  private readonly denialStreakThreshold: number
  private globalAutoDenials = 0
  private readonly globalDenialPromptThreshold: number
  private readonly denialStateStore?: DenialStateStore
  private readonly persistRule?: (rule: PermissionRule) => Promise<void>
  private readonly cwd: string
  /** Extra workspace roots for accept-edits, from `permissions.additionalDirectories`. */
  private readonly additionalDirectories: string[]
  private denialStateLoaded = false
  private readonly modeListeners = new Set<PermissionModeListener>()

  constructor(
    private readonly prompt: PermissionPrompt,
    configRules?: PermissionRule[],
    options?: {
      denialStreakThreshold?: number
      globalDenialPromptThreshold?: number
      mode?: PermissionMode
      denialStateStore?: DenialStateStore
      cwd?: string
      additionalDirectories?: string[]
      persistRule?: (rule: PermissionRule) => Promise<void>
      sessionRuleStore?: SessionRuleStore
    },
  ) {
    this.sessionRuleStore = options?.sessionRuleStore ?? createSessionRuleStore()
    this.addRules(configRules ?? [])
    this.mode = options?.mode ?? 'default'
    const configured = options?.denialStreakThreshold ?? DEFAULT_DENIAL_STREAK_THRESHOLD
    this.denialStreakThreshold = Math.max(1, configured)
    const globalConfigured = options?.globalDenialPromptThreshold ?? DEFAULT_GLOBAL_DENIAL_PROMPT_THRESHOLD
    this.globalDenialPromptThreshold = Math.max(1, globalConfigured)
    this.denialStateStore = options?.denialStateStore
    this.cwd = options?.cwd ?? process.cwd()
    this.additionalDirectories = (options?.additionalDirectories ?? [])
      .map((dir) => dir.trim())
      .filter((dir) => dir !== '')
      .map((dir) => path.resolve(this.cwd, dir))
    this.persistRule = options?.persistRule
  }

  async approve(tool: Tool, input: unknown): Promise<boolean> {
    return (await this.approveDetailed(tool, input)).approved
  }

  async approveDetailed(tool: Tool, input: unknown): Promise<PermissionDecision> {
    await this.hydrateDenialState()

    // 1. Safe tools are approved unless shell/path safety found a reason to
    //    deny or force a prompt first.
    const commandAnalysis = this.commandAnalysisFor(tool.name, input)
    const path = extractFilePath(input)
    // Protected paths guard *edits* (the list is Claude Code's
    // isDangerousFilePathToAutoEdit). Reading .git/config or grepping
    // .myagent/ is ordinary work and must not be gated.
    const isWrite = this.isWriteOperation(tool, commandAnalysis)
    const hasProtectedPath = isWrite && (
      (commandAnalysis?.hasProtectedPath ?? false)
      || (path !== '' && isProtectedPath(path))
    )
    // NTFS ADS, UNC paths, DOS device names, 8.3 short names and trailing
    // dots. Checked in every mode: it used to run only under bypass, so the
    // loosest mode was the only one enforcing it.
    const windowsPathCheck = checkWindowsPathSafety(path)
    // "Cannot be auto-approved, must ask" — never "deny without asking".
    const blocksAutoApproval =
      (commandAnalysis?.hasSafetyDenyIssue ?? false)
      || (commandAnalysis?.requiresSafetyPrompt ?? false)
      || hasProtectedPath
      || windowsPathCheck.suspicious
      || this.hasDangerousRemoval(commandAnalysis)
    const requiresSafetyPrompt = blocksAutoApproval

    const deniedByRule = this.matchingRule('deny', tool.name, input, commandAnalysis)
    const askedByRule = this.matchingRule('ask', tool.name, input, commandAnalysis)
    const allowedByRule = this.matchingRule('allow', tool.name, input, commandAnalysis)

    if (this.mode === 'bypass') {
      // Deny rules are bypass-immune (aligned with Claude Code step 1a), but
      // the user gets to decide: prompt instead of silently denying.
      if (deniedByRule) {
        const previousStreak = this.denialStreaks.get(tool.name) ?? 0
        const approved = await this.prompt({
          tool,
          input,
          reason: `A permission rule denies ${tool.name}. Confirm to override the deny rule.`,
          source: 'deny rule',
          matchedRule: deniedByRule,
          denialStreak: 0,
        })
        this.recordPromptDecision(tool.name, approved, previousStreak)
        return this.persistAndReturn(userDecision(approved, 'deny rule', tool))
      }

      // Ask rules are bypass-immune, both tool-wide and content-specific
      // (aligned with Claude Code steps 1b/1f).
      if (askedByRule) {
        return this.promptForDecision(
          tool,
          input,
          `Permission rule asks before running ${tool.name}.`,
          'ask rule',
          false,
          { matchedRule: askedByRule, commandAnalysis },
        )
      }

      // Windows path safety checks are bypass-immune (aligned with Claude Code's
      // classifierApprovable: false): NTFS ADS, UNC paths, DOS device names,
      // 8.3 short names, and trailing dots/spaces cannot be silently approved.
      // Windows path safety checks are bypass-immune (aligned with Claude Code's
      // classifierApprovable: false).
      if (windowsPathCheck.suspicious) {
        const approved = await this.prompt({
          tool,
          input,
          reason: `Suspicious path: ${windowsPathCheck.reason}`,
          source: 'protected path',
          denialStreak: 0,
        })
        this.denialStreaks.set(tool.name, 0)
        return this.persistAndReturn(userDecision(approved, 'protected path', tool))
      }

      // Protected-path safety checks are bypass-immune (aligned with Claude
      // Code step 1g, which is a path safetyCheck only).
      if (hasProtectedPath) {
        const approved = await this.prompt({
          tool,
          input,
          reason: this.protectedPathBypassReason(input, commandAnalysis),
          source: 'protected path',
          denialStreak: 0,
        })
        this.denialStreaks.set(tool.name, 0)
        return this.persistAndReturn(userDecision(approved, 'protected path', tool))
      }

      // Everything else is allowed silently: shell syntax findings and
      // destructive commands are not bypass-immune (aligned with Claude Code,
      // where Bash syntax analysis only produces ask results that bypass
      // mode approves at step 2a).
      this.denialStreaks.set(tool.name, 0)
      return this.persistAndReturn(approvedDecision('mode'))
    }

    if (this.mode === 'plan') {
      const planFileWrite = this.isSessionPlanFile(tool, input)
      if (hasProtectedPath && !planFileWrite) {
        const approved = await this.prompt({
          tool,
          input,
          reason: this.protectedPathBypassReason(input, commandAnalysis),
          source: 'protected path',
          denialStreak: 0,
        })
        this.denialStreaks.set(tool.name, 0)
        return this.persistAndReturn(userDecision(approved, 'protected path', tool))
      }
      if (blocksAutoApproval && !planFileWrite) {
        const source = this.promptSourceForSafety(commandAnalysis, hasProtectedPath)
        const approved = await this.prompt({
          tool,
          input,
          reason: `Shell safety check: ${commandAnalysis?.categories?.join(', ') ?? 'dangerous pattern detected'}`,
          source,
          denialStreak: 0,
        })
        this.denialStreaks.set(tool.name, 0)
        return this.persistAndReturn(userDecision(approved, source, tool))
      }
      this.denialStreaks.set(tool.name, 0)
      return this.persistAndReturn(approvedDecision('mode'))
    }

    if (this.mode === 'readonly') {
      if (tool.isReadOnly === true && !blocksAutoApproval) {
        this.denialStreaks.set(tool.name, 0)
        return this.persistAndReturn(approvedDecision('mode'))
      }
      if (tool.name === 'Bash' && commandAnalysis && !blocksAutoApproval && commandAnalysis.isReadOnly) {
        this.denialStreaks.set(tool.name, 0)
        return this.persistAndReturn(approvedDecision('mode'))
      }
      this.denialStreaks.set(tool.name, 0)
      return this.persistAndReturn({
        approved: false,
        source: 'readonly mode',
        denialReason: `Read-only permission mode blocks ${tool.name}. Ask the user to leave read-only mode if this call is needed.`,
      })
    }

    // A deny rule is the one thing the user configured to block outright, so it
    // is the only silent denial left. Safety findings prompt instead: the user
    // never saw them, and a silent failure only makes the model retry.
    if (deniedByRule) {
      const escalated = await this.handleAutoDeny(tool, input, commandAnalysis, true, 'deny rule', deniedByRule)
      if (escalated !== undefined) {
        return this.persistAndReturn(escalated
          ? approvedDecision('deny rule')
          : {
            approved: false,
            source: 'deny rule',
            denialReason: `Blocked by a permission deny rule: ${permissionRuleToEntry(deniedByRule)}. Do not retry this call; a different approach or an explicit user change to permissions is required.`,
          })
      }
    }

    if (askedByRule) {
      // A session-level "always allow" decision (made by the user at an
      // earlier prompt) overrides config ask rules; without one, prompt.
      // On a session allow match, execution falls through to the allow-rule
      // approval below. (Bypass-mode ask prompts are handled in the bypass
      // branch above and never reach this block.)
      if (!this.sessionRuleMatches('allow', tool.name, input, commandAnalysis)) {
        return this.promptForDecision(
          tool,
          input,
          `Permission rule asks before running ${tool.name}.`,
          'ask rule',
          false,
          { matchedRule: askedByRule, commandAnalysis },
        )
      }
    }

    // Aligned with Claude Code step 7: read-only Bash is auto-allowed.
    if (
      (this.mode === 'default' || this.mode === 'acceptEdits')
      && tool.name === 'Bash'
      && commandAnalysis?.isReadOnly
      && !blocksAutoApproval
    ) {
      this.denialStreaks.set(tool.name, 0)
      return this.persistAndReturn(approvedDecision('mode'))
    }

    if (
      this.mode === 'acceptEdits'
      && this.isAcceptEditsAllowed(tool, input, commandAnalysis)
      && !blocksAutoApproval
    ) {
      this.denialStreaks.set(tool.name, 0)
      return this.persistAndReturn(approvedDecision('mode'))
    }

    // Aligned with Claude Code §5.3: a fetch of a preapproved documentation
    // host needs no prompt; every other host does, which is why WebFetch is
    // not a `safe` tool.
    if (tool.name === WEB_FETCH_TOOL_NAME && !blocksAutoApproval && isPreapprovedUrl(extractUrl(input))) {
      this.denialStreaks.set(tool.name, 0)
      return this.persistAndReturn(approvedDecision('mode'))
    }

    if (tool.riskLevel === 'safe' && !blocksAutoApproval) {
      this.denialStreaks.set(tool.name, 0)
      return this.persistAndReturn(approvedDecision('mode'))
    }

    // 2. Safety findings disable auto-allow — an allow rule cannot blanket-approve
    //    a command substitution or a protected-path write — but the user still
    //    makes the decision in the normal permission prompt.
    if (!blocksAutoApproval && allowedByRule) {
      this.denialStreaks.set(tool.name, 0)
      return this.persistAndReturn(approvedDecision('allow rule'))
    }

    // 4. Prompt user
    return this.promptForDecision(
      tool,
      input,
      windowsPathCheck.suspicious
        ? `Suspicious path: ${windowsPathCheck.reason}`
        : this.reasonFor(tool.riskLevel, commandAnalysis?.categories, false, this.denialStreaks.get(tool.name) ?? 0),
      windowsPathCheck.suspicious
        ? 'protected path'
        : this.promptSourceForNormalPrompt(commandAnalysis, blocksAutoApproval, allowedByRule, hasProtectedPath),
      false,
      { matchedRule: allowedByRule, commandAnalysis },
    )
  }

  /**
   * Whether this call can change anything. Protected paths only gate writes;
   * Bash answers through its shell analysis rather than its tool metadata.
   */
  private isWriteOperation(
    tool: Tool,
    commandAnalysis: ReturnType<typeof analyzeShellCommand> | undefined,
  ): boolean {
    if (tool.name === 'Bash') return !(commandAnalysis?.isReadOnly ?? false)
    return tool.isReadOnly !== true
  }

  private async promptForDecision(
    tool: Tool,
    input: unknown,
    reason: string,
    source: PermissionDecisionSource,
    wouldAutoDeny: boolean,
    options: {
      matchedRule?: PermissionRule
      commandAnalysis?: ReturnType<typeof analyzeShellCommand>
    } = {},
  ): Promise<PermissionDecision> {
    const previousStreak = this.denialStreaks.get(tool.name) ?? 0
    let alwaysAllow = false
    const alwaysAllowRule = this.shouldOfferAlwaysAllow(source)
      ? buildSessionAllowRule(tool, input, options.commandAnalysis)
      : undefined
    const approved = await this.prompt({
      tool,
      input,
      reason,
      source,
      ...(options.matchedRule ? { matchedRule: options.matchedRule } : {}),
      ...(alwaysAllowRule ? { alwaysAllowRule } : {}),
      denialStreak: wouldAutoDeny ? previousStreak + 1 : 0,
      ...(alwaysAllowRule ? { onAlwaysAllow: () => { alwaysAllow = true } } : {}),
    })

    // 5. Decision recorded. Explicit approval clears the loop signal. Explicit
    //    denial keeps it near the threshold so repeated requests keep prompting
    //    instead of falling back to silent auto-denial.
    this.recordPromptDecision(tool.name, approved, previousStreak)

    // 6. If user chose "always allow", add session rule and persist it so the
    //    rule survives restarts (writes to the project's settings.local.json).
    if (approved && alwaysAllow && alwaysAllowRule) {
      this.addSessionRule(alwaysAllowRule)
      if (this.persistRule) {
        try {
          await this.persistRule(alwaysAllowRule)
        } catch {
          // Persistence is best-effort; the in-memory session rule still applies.
        }
      }
    }

    return this.persistAndReturn(userDecision(approved, source, tool))
  }

  addSessionRule(rule: PermissionRule): void {
    this.addRules([rule])
  }

  addSessionRules(rules: PermissionRule[]): void {
    this.addRules(rules)
  }

  setConfigRules(rules: PermissionRule[]): void {
    this.configRules = []
    this.addRules(rules)
  }

  setPlanSlugProvider(provider: () => string | undefined): void {
    this.planSlugProvider = provider
  }

  /**
   * Uninstalls `provider` only if it is still the installed one. A disposed
   * runtime therefore cannot clear the provider of the runtime that replaced
   * it, whatever order dispose happens to run in.
   */
  clearPlanSlugProvider(provider: () => string | undefined): void {
    if (this.planSlugProvider === provider) this.planSlugProvider = undefined
  }

  /**
   * Drops the in-memory denial counters and re-arms hydration. Called when the
   * gate starts serving a different session (`/clear`, `/resume`): without it
   * the previous session's streaks stay latched and get persisted onto the new
   * session on the next auto-denial.
   */
  resetDenialState(): void {
    this.denialStreaks = new Map()
    this.globalAutoDenials = 0
    this.denialStateLoaded = false
  }

  getConfigRules(): PermissionRule[] {
    return [...this.configRules]
  }

  getSessionRules(): PermissionRule[] {
    return [...this.sessionRuleStore.rules]
  }

  getSessionRuleStore(): SessionRuleStore {
    return this.sessionRuleStore
  }

  /** Resolved extra workspace roots, so a subagent gate can inherit them. */
  getAdditionalDirectories(): string[] {
    return [...this.additionalDirectories]
  }

  getMode(): PermissionMode {
    return this.mode
  }

  getPrePlanMode(): PermissionMode {
    return this.prePlanMode
  }

  isBypassAvailable(): boolean {
    return true
  }

  onModeChange(listener: PermissionModeListener): () => void {
    this.modeListeners.add(listener)
    return () => {
      this.modeListeners.delete(listener)
    }
  }

  getDenialState(): DenialState {
    return normalizeDenialState({
      streaks: Object.fromEntries(this.denialStreaks),
      total: this.globalAutoDenials,
    })
  }

  setMode(mode: PermissionMode): void {
    if (this.mode === mode) return
    if (mode === 'plan') {
      this.prePlanMode = this.mode
    }
    if (this.mode === 'plan' && mode !== 'plan') {
      this.prePlanMode = 'default'
    }
    this.mode = mode
    for (const listener of this.modeListeners) {
      listener(mode)
    }
  }

  exitPlanMode(): PermissionMode {
    if (this.mode !== 'plan') return this.mode
    const restoredMode = this.prePlanMode === 'plan' ? 'default' : this.prePlanMode
    this.prePlanMode = 'default'
    this.mode = restoredMode
    for (const listener of this.modeListeners) {
      listener(restoredMode)
    }
    return restoredMode
  }

  /** Transition gate into plan mode, saving the current mode. */
  prepareContextForPlanMode(): void {
    this.setMode('plan')
  }

  /** Restore gate from plan mode to the pre-plan mode. */
  restoreFromPlanMode(): void {
    this.exitPlanMode()
  }

  createApprovalRecord(tool: Tool, input: unknown, approved: boolean, turnId?: string): ToolApprovalRecord {
    return {
      id: randomUUID(),
      type: 'tool_approval',
      tool: tool.name,
      input,
      approved,
      riskLevel: tool.riskLevel,
      ...(turnId ? { turnId } : {}),
      createdAt: new Date().toISOString(),
    }
  }

  private matchingRule(
    behavior: PermissionRule['behavior'],
    toolName: string,
    input: unknown,
    commandAnalysis: ReturnType<typeof analyzeShellCommand> | undefined,
  ): PermissionRule | undefined {
    const allRules = [...this.configRules, ...this.sessionRuleStore.rules]
    return allRules.find((r) => r.behavior === behavior && this.matchesRule(r, toolName, input, commandAnalysis))
  }

  private sessionRuleMatches(
    behavior: PermissionRule['behavior'],
    toolName: string,
    input: unknown,
    commandAnalysis: ReturnType<typeof analyzeShellCommand> | undefined,
  ): boolean {
    return this.sessionRuleStore.rules.some((r) => r.behavior === behavior && this.matchesRule(r, toolName, input, commandAnalysis))
  }

  private matchesRule(
    rule: PermissionRule,
    toolName: string,
    input: unknown,
    commandAnalysis: ReturnType<typeof analyzeShellCommand> | undefined,
  ): boolean {
    if (!ruleAppliesToTool(rule.toolName, toolName)) return false
    if (!rule.contentPattern) return true

    if (toolName in HOST_SCOPED_TOOLS && rule.contentPattern.startsWith(DOMAIN_RULE_PREFIX)) {
      const url = hostScopedUrl(toolName, input)
      // No URL in this call means no host to compare: a `domain:` rule cannot
      // match it either way, and falling through to the glob below would
      // compare the pattern against a JSON blob.
      if (!url) return false
      return matchesDomainRule(rule.contentPattern.slice(DOMAIN_RULE_PREFIX.length), url)
    }

    if (toolName === 'Bash') {
      const command = extractRuleContent(input)
      if (!command) return false
      // deny/ask rules strip ALL env var prefixes and match compound commands
      // (whole + each segment) so a denied subcommand stays denied regardless
      // of prefix wrapping. allow rules match the whole command only — the
      // compound guard blocks compounds, since Hanekawa cannot verify every
      // segment shares the rule the way Claude Code's per-subcommand flow does.
      const stripAll = rule.behavior === 'deny' || rule.behavior === 'ask'
      const candidates = stripAll ? [command, ...(commandAnalysis?.segments ?? bashCommandSegments(command))] : [command]
      return matchBashRule(rule.contentPattern, candidates, {
        stripAllEnvVars: stripAll,
        skipCompoundCheck: stripAll,
      })
    }

    const content = extractRuleContent(input) || (typeof input === 'string' ? input : JSON.stringify(input))
    if (content === rule.contentPattern) return true
    return matchGlob(content, rule.contentPattern)
  }

  private addRules(rules: PermissionRule[]): void {
    for (const rule of rules) {
      if (rule.source === 'config') {
        this.configRules = dedupePermissionRules([...this.configRules, rule])
      } else {
        this.sessionRuleStore.add(rule)
      }
    }
  }

  private commandAnalysisFor(toolName: string, input: unknown): ReturnType<typeof analyzeShellCommand> | undefined {
    if (toolName !== 'Bash' || !input || typeof input !== 'object') return undefined
    const command = (input as { command?: unknown }).command
    if (typeof command !== 'string') return undefined
    return analyzeShellCommand(command)
  }

  private async handleAutoDeny(
    tool: Tool,
    input: unknown,
    commandAnalysis: ReturnType<typeof analyzeShellCommand> | undefined,
    wouldAutoDeny: boolean,
    source: PermissionDecisionSource,
    matchedRule?: PermissionRule,
  ): Promise<boolean | undefined> {
    const streak = (this.denialStreaks.get(tool.name) ?? 0) + 1
    const nextGlobalAutoDenials = this.globalAutoDenials + 1
    const globalEscalated = nextGlobalAutoDenials > this.globalDenialPromptThreshold
    if (streak < this.denialStreakThreshold && !globalEscalated) {
      this.denialStreaks.set(tool.name, streak)
      this.globalAutoDenials = nextGlobalAutoDenials
      return false
    }

    const previousStreak = this.denialStreaks.get(tool.name) ?? 0
    const reason = this.reasonFor(tool.riskLevel, commandAnalysis?.categories, wouldAutoDeny, previousStreak, globalEscalated)
    const approved = await this.prompt({
      tool,
      input,
      reason,
      source,
      ...(matchedRule ? { matchedRule } : {}),
      denialStreak: previousStreak + 1,
    })

    this.recordPromptDecision(tool.name, approved, previousStreak)

    return approved
  }

  private isSessionPlanFile(tool: Tool, input: unknown): boolean {
    if (tool.name !== 'Write' && tool.name !== 'Edit' && tool.name !== 'MultiEdit') return false
    const slug = this.planSlugProvider?.()
    if (!slug) return false
    const filePath = extractFilePath(input)
    if (!filePath) return false
    const absolute = path.resolve(filePath)
    const expectedPrefix = path.resolve(getPlansDir(this.cwd), slug)
    return absolute.startsWith(expectedPrefix) && absolute.endsWith('.md')
  }

  private isAcceptEditsAllowed(
    tool: Tool,
    input: unknown,
    commandAnalysis: ReturnType<typeof analyzeShellCommand> | undefined,
  ): boolean {
    if (ACCEPT_EDITS_TOOLS.has(tool.name)) {
      // acceptEdits only auto-approves edits inside the working directory
      // (aligned with Claude Code); outside paths fall through to the prompt.
      const filePath = extractFilePath(input)
      return filePath !== '' && this.isSafeWorkspacePathOperand(filePath)
    }
    if (tool.name !== 'Bash' || !commandAnalysis) return false
    return this.isLightWorkspaceShellWrite(commandAnalysis)
  }

  private isLightWorkspaceShellWrite(commandAnalysis: ReturnType<typeof analyzeShellCommand>): boolean {
    if (commandAnalysis.categories.some((category) => category !== ACCEPT_EDITS_ALLOWED_CATEGORY)) return false
    if (commandAnalysis.hasSafetyDenyIssue || commandAnalysis.requiresSafetyPrompt || commandAnalysis.hasProtectedPath) return false
    const words = shellWords(commandAnalysis.command)
    if (words.length === 0) return false
    const executable = basename(words[0]!).toLowerCase()
    if (!ACCEPT_EDITS_BASH_COMMANDS.has(executable)) return false
    const args = words.slice(1)
    // `mv`/`cp` reject every flag rather than filtering them out: a flag can
    // carry the destination (`cp --target-directory=/etc a.txt`), which the
    // operand scan below would never see. Claude Code's COMMAND_VALIDATOR does
    // the same, and for the same reason.
    if ((executable === 'mv' || executable === 'cp') && args.some((arg) => arg.startsWith('-'))) return false
    const operands = executable === 'sed' ? this.acceptEditsSedOperands(args) : positionalArguments(args)
    if (operands === undefined || operands.length === 0) return false
    return operands.every((operand) => this.isSafeWorkspacePathOperand(operand))
  }

  /**
   * The files an accept-edits `sed` may touch, or undefined when the invocation
   * is outside the substitution allowlist accept-edits covers.
   */
  private acceptEditsSedOperands(args: string[]): string[] | undefined {
    const sed = parseSedInvocation(args)
    if (!sed || !isAcceptEditsSedSubstitution(sed)) return undefined
    return sed.operands
  }

  /**
   * Whether any `rm`/`rmdir` segment targets a path that must never be
   * auto-approved. Folded into `blocksAutoApproval`, not just the accept-edits
   * check, because Claude Code makes this unreachable by an allow rule too: an
   * `Bash(rm:*)` rule must not silently cover `rm -rf /`.
   */
  private hasDangerousRemoval(commandAnalysis: ReturnType<typeof analyzeShellCommand> | undefined): boolean {
    for (const segment of commandAnalysis?.segments ?? []) {
      const words = shellWords(segment)
      if (words.length === 0) continue
      const executable = basename(words[0]!).toLowerCase()
      if (executable !== 'rm' && executable !== 'rmdir') continue
      for (const operand of positionalArguments(words.slice(1))) {
        const expanded = operand === '~' || operand.startsWith('~/')
          ? path.join(homedir(), operand.slice(1))
          : operand
        if (isDangerousRemovalPath(path.resolve(this.cwd, expanded), homedir())) return true
      }
    }
    return false
  }

  private isSafeWorkspacePathOperand(operand: string): boolean {
    if (operand === '.' || operand === '..') return false
    if (/[\0\r\n*?[\]{}$`~]/.test(operand)) return false
    if (isProtectedPath(operand)) return false
    const resolved = path.resolve(this.cwd, operand)
    const roots = [path.resolve(this.cwd), ...this.additionalDirectories]
    return roots.some((root) => resolved === root || resolved.startsWith(root + path.sep))
  }

  private promptSourceForSafety(
    commandAnalysis: ReturnType<typeof analyzeShellCommand> | undefined,
    hasProtectedPath: boolean,
  ): PermissionDecisionSource {
    if (hasProtectedPath || commandAnalysis?.hasProtectedPath) return 'protected path'
    return 'bash safety'
  }

  private promptSourceForNormalPrompt(
    commandAnalysis: ReturnType<typeof analyzeShellCommand> | undefined,
    requiresSafetyPrompt: boolean,
    allowedByRule: PermissionRule | undefined,
    hasProtectedPath: boolean,
  ): PermissionDecisionSource {
    if (allowedByRule) return 'allow rule'
    // `hasProtectedPath` has to be passed through: a non-Bash tool has no
    // command analysis, so hardcoding `false` here labelled every protected-path
    // write `bash safety`, which is not what the dialog should say a `Delete`
    // of `.git/config` was stopped by.
    if (requiresSafetyPrompt) return this.promptSourceForSafety(commandAnalysis, hasProtectedPath)
    return 'mode'
  }

  private shouldOfferAlwaysAllow(source: PermissionDecisionSource): boolean {
    if (this.mode === 'bypass') return false
    return source === 'mode' || source === 'ask rule'
  }

  private recordPromptDecision(toolName: string, approved: boolean, previousStreak: number): void {
    if (approved) {
      this.denialStreaks.set(toolName, 0)
      return
    }

    this.denialStreaks.set(toolName, Math.max(previousStreak, this.denialStreakThreshold - 1, 0))
  }

  private async hydrateDenialState(): Promise<void> {
    if (!this.denialStateStore || this.denialStateLoaded) return
    this.denialStateLoaded = true
    try {
      const state = normalizeDenialState(await this.denialStateStore.getDenialState())
      this.denialStreaks = new Map(Object.entries(state.streaks))
      this.globalAutoDenials = state.total
    } catch {
      // Persistence is best-effort; in-memory counters still protect this process.
    }
  }

  private async persistAndReturn<T>(value: T): Promise<T> {
    if (this.denialStateStore) {
      try {
        await this.denialStateStore.setDenialState(this.getDenialState())
      } catch {
        // Permission decisions must not fail because telemetry persistence did.
      }
    }
    return value
  }

  private protectedPathBypassReason(
    input: unknown,
    commandAnalysis: ReturnType<typeof analyzeShellCommand> | undefined,
  ): string {
    const matches = this.protectedPathMatches(input, commandAnalysis)
    const suffix = matches.length > 0
      ? ` Matched protected path${matches.length === 1 ? '' : 's'}: ${matches.join(', ')}.`
      : ''
    return `Even in bypass mode, protected paths require explicit confirmation.${suffix}`
  }

  private protectedPathMatches(
    input: unknown,
    commandAnalysis: ReturnType<typeof analyzeShellCommand> | undefined,
  ): string[] {
    const matches = new Set<string>()
    const path = extractFilePath(input)
    if (path !== '' && isProtectedPath(path)) matches.add(path)

    for (const segment of commandAnalysis?.segments ?? []) {
      for (const word of shellWords(segment)) {
        if (isProtectedPath(word)) matches.add(word)
      }
      if (matches.size === 0 && isProtectedPath(segment)) matches.add(segment)
    }

    return [...matches]
  }

  private reasonFor(
    riskLevel: RiskLevel,
    commandCategories: string[] | undefined,
    wouldAutoDeny: boolean,
    previousStreak: number,
    globalEscalated = false,
  ): string {
    if (globalEscalated) {
      return `This action would normally be auto-denied, but the session has already had ${this.globalAutoDenials} auto-denials. Confirm explicitly to proceed, or deny to keep blocking it.`
    }
    if (wouldAutoDeny && previousStreak + 1 >= this.denialStreakThreshold) {
      return `This action would normally be auto-denied (protected path or deny rule), but the model has now requested it ${previousStreak + 1} times in a row. Confirm explicitly to proceed, or deny to keep blocking it.`
    }
    if (commandCategories && commandCategories.length > 0) {
      return `This shell command requires confirmation because it includes: ${commandCategories.join(', ')}.`
    }
    if (riskLevel === 'confirm') return 'This action changes local state and requires confirmation.'
    return 'This is a dangerous action and requires explicit confirmation.'
  }
}


export function normalizeDenialState(state: Partial<DenialState> | undefined): DenialState {
  const streaks: Record<string, number> = {}
  for (const [toolName, rawCount] of Object.entries(state?.streaks ?? {})) {
    if (typeof rawCount !== 'number' || !Number.isFinite(rawCount)) continue
    const count = Math.max(0, Math.floor(rawCount))
    if (count > 0) streaks[toolName] = count
  }
  const rawTotal = state?.total
  const total = typeof rawTotal === 'number' && Number.isFinite(rawTotal)
    ? Math.max(0, Math.floor(rawTotal))
    : 0
  return { streaks, total }
}

function basename(command: string): string {
  const normalized = command.replace(/\\/g, '/')
  const slash = normalized.lastIndexOf('/')
  return slash === -1 ? normalized : normalized.slice(slash + 1)
}
