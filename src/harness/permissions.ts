import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import path from 'node:path'
import { analyzeShellCommand } from './commandAnalysis.js'
import { shellWords } from './bashSafety.js'
import {
  isSafeAutoTool,
  classifyWithUserRules,
  isPlanReadOnlyShellCommand,
  type AutoModeConfig,
} from './autoClassifier.js'
import type { RiskLevel, Tool, ToolApprovalRecord } from './types.js'
import { isProtectedPath } from '../utils/permissions/protectedPaths.js'
import { EXIT_PLAN_MODE_TOOL_NAME } from '../tools/toolNames.js'
import { getPlansDir } from '../utils/plans.js'

const require = createRequire(import.meta.url)
const picomatch = require('picomatch') as {
  isMatch(input: string, pattern: string, options?: { nocase?: boolean }): boolean
}

export type PermissionMode = 'default' | 'plan' | 'acceptEdits' | 'auto' | 'bypass'

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
// `Delete` stays excluded so accept-edits mode cannot silently remove files.
const ACCEPT_EDITS_TOOLS = new Set(['Edit', 'Write', 'MultiEdit'])
const FILE_PERMISSION_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'Delete'])
const ACCEPT_EDITS_BASH_COMMANDS = new Set(['mkdir', 'touch'])
const PLAN_ALLOWED_AGENT_TYPES = new Set(['general', 'fork', 'explore', 'plan'])

export { isProtectedPath } from '../utils/permissions/protectedPaths.js'

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

function extractPath(input: unknown): string {
  if (typeof input === 'string') return input
  if (input && typeof input === 'object') {
    const obj = input as Record<string, unknown>
    if (typeof obj.path === 'string') return obj.path
    if (typeof obj.filePath === 'string') return obj.filePath
    if (typeof obj.command === 'string') return obj.command
  }
  return ''
}

function buildSessionAllowRule(
  tool: Tool,
  input: unknown,
  commandAnalysis: ReturnType<typeof analyzeShellCommand> | undefined,
): PermissionRule | undefined {
  if (tool.name === 'Bash') {
    if (!commandAnalysis) return undefined
    if (commandAnalysis.categories.length > 0) return undefined
    if (commandAnalysis.hasSafetyDenyIssue || commandAnalysis.requiresSafetyPrompt || commandAnalysis.hasProtectedPath) {
      return undefined
    }
    if (commandAnalysis.segments.length !== 1) return undefined
    const command = commandAnalysis.command.trim()
    if (!command) return undefined
    return { toolName: tool.name, contentPattern: command, behavior: 'allow', source: 'session' }
  }

  if (FILE_PERMISSION_TOOLS.has(tool.name)) {
    const filePath = extractPath(input).trim()
    if (!filePath || isProtectedPath(filePath)) return undefined
    return { toolName: tool.name, contentPattern: filePath, behavior: 'allow', source: 'session' }
  }

  return { toolName: tool.name, behavior: 'allow', source: 'session' }
}

function matchGlob(content: string, pattern: string): boolean {
  // Use picomatch for safe, ReDoS-immune glob matching.
  return picomatch.isMatch(content, pattern, { nocase: true })
}

export class PermissionGate {
  private sessionRules: PermissionRule[] = []
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
  private readonly cwd: string
  private readonly autoModeConfig?: AutoModeConfig
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
      autoModeConfig?: AutoModeConfig
    },
  ) {
    this.addRules(configRules ?? [])
    this.mode = options?.mode ?? 'default'
    this.autoModeConfig = options?.autoModeConfig
    const configured = options?.denialStreakThreshold ?? DEFAULT_DENIAL_STREAK_THRESHOLD
    this.denialStreakThreshold = Math.max(1, configured)
    const globalConfigured = options?.globalDenialPromptThreshold ?? DEFAULT_GLOBAL_DENIAL_PROMPT_THRESHOLD
    this.globalDenialPromptThreshold = Math.max(1, globalConfigured)
    this.denialStateStore = options?.denialStateStore
    this.cwd = options?.cwd ?? process.cwd()
    // Strip dangerous permissions when starting in auto mode
    if (this.mode === 'auto') {
      this.stripDangerousPermissions()
    }
  }

  async approve(tool: Tool, input: unknown): Promise<boolean> {
    await this.hydrateDenialState()

    // 1. Safe tools are approved unless shell/path safety found a reason to
    //    deny or force a prompt first.
    const commandAnalysis = this.commandAnalysisFor(tool.name, input)
    const path = extractPath(input)
    const hasProtectedPath =
      (commandAnalysis?.hasProtectedPath ?? false)
      || (path !== '' && isProtectedPath(path))
    const hasHardSafetyDenial =
      (commandAnalysis?.hasSafetyDenyIssue ?? false)
      || hasProtectedPath
    const requiresSafetyPrompt = commandAnalysis?.requiresSafetyPrompt ?? false

    const deniedByRule = this.matchingRule('deny', tool.name, input)
    const askedByRule = this.matchingRule('ask', tool.name, input)
    const allowedByRule = this.matchingRule('allow', tool.name, input)

    if (this.mode === 'bypass') {
      if (hasProtectedPath) {
        const approved = await this.prompt({
          tool,
          input,
          reason: this.protectedPathBypassReason(input, commandAnalysis),
          source: 'protected path',
          denialStreak: 0,
        })
        this.denialStreaks.set(tool.name, 0)
        return this.persistAndReturn(approved)
      }

      // Shell safety checks are bypass-immune (aligned with Claude Code):
      // hasSafetyDenyIssue and requiresSafetyPrompt always prompt even in
      // bypass mode. This prevents dangerous patterns like sudo, bash -c,
      // UNC paths, and command substitution from being silently auto-approved.
      if (hasHardSafetyDenial || requiresSafetyPrompt) {
        const approved = await this.prompt({
          tool,
          input,
          reason: `Shell safety check: ${commandAnalysis?.categories?.join(', ') ?? 'dangerous pattern detected'}`,
          source: this.promptSourceForSafety(commandAnalysis, hasProtectedPath),
          denialStreak: 0,
        })
        this.denialStreaks.set(tool.name, 0)
        return this.persistAndReturn(approved)
      }

      // For Bash, use commandAnalysis to identify truly destructive commands;
      // otherwise fall back to the tool-level isDestructive flag.
      const isDestructiveCall = tool.name === 'Bash'
        ? (commandAnalysis?.categories.includes('destructive filesystem or git operation') ?? false)
        : tool.isDestructive === true

      if (isDestructiveCall) {
        const previousStreak = this.denialStreaks.get(tool.name) ?? 0
        const approved = await this.prompt({
          tool,
          input,
          reason: this.reasonFor(tool.riskLevel, commandAnalysis?.categories, false, previousStreak),
          source: this.promptSourceForSafety(commandAnalysis, false),
          denialStreak: 0,
        })
        this.recordPromptDecision(tool.name, approved, previousStreak)
        return this.persistAndReturn(approved)
      }

      this.denialStreaks.set(tool.name, 0)
      return this.persistAndReturn(true)
    }

    if (this.mode === 'plan') {
      const allowedPlanFileWrite = this.isAllowedPlanFileWrite(tool, input, requiresSafetyPrompt)
      if ((hasHardSafetyDenial && !allowedPlanFileWrite) || deniedByRule) {
        const escalated = await this.handleAutoDeny(
          tool,
          input,
          commandAnalysis,
          true,
          deniedByRule ? 'deny rule' : this.promptSourceForSafety(commandAnalysis, hasProtectedPath),
          deniedByRule,
        )
        if (escalated !== undefined) return this.persistAndReturn(escalated)
      }
      const planAllowed = this.isPlanAllowed(tool, input, commandAnalysis, hasHardSafetyDenial, requiresSafetyPrompt)
      if (!planAllowed) {
        this.denialStreaks.set(tool.name, 0)
        return this.persistAndReturn(false)
      }
      if (askedByRule || requiresSafetyPrompt) {
        return this.promptForDecision(
          tool,
          input,
          askedByRule
            ? `Permission rule asks before running ${tool.name}.`
            : this.reasonFor(tool.riskLevel, commandAnalysis?.categories, false, 0),
          askedByRule ? 'ask rule' : this.promptSourceForSafety(commandAnalysis, false),
          false,
          { matchedRule: askedByRule, commandAnalysis },
        )
      }
      if (planAllowed) {
        this.denialStreaks.set(tool.name, 0)
        return this.persistAndReturn(true)
      }
    }

    if (hasHardSafetyDenial) {
      const escalated = await this.handleAutoDeny(
        tool,
        input,
        commandAnalysis,
        true,
        this.promptSourceForSafety(commandAnalysis, hasProtectedPath),
      )
      if (escalated !== undefined) return this.persistAndReturn(escalated)
    }

    if (deniedByRule) {
      const escalated = await this.handleAutoDeny(tool, input, commandAnalysis, true, 'deny rule', deniedByRule)
      if (escalated !== undefined) return this.persistAndReturn(escalated)
    }

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

    if (
      this.mode === 'acceptEdits'
      && this.isAcceptEditsAllowed(tool, input, commandAnalysis)
      && !requiresSafetyPrompt
    ) {
      this.denialStreaks.set(tool.name, 0)
      return this.persistAndReturn(true)
    }

    if (tool.riskLevel === 'safe' && !hasHardSafetyDenial && !requiresSafetyPrompt) {
      this.denialStreaks.set(tool.name, 0)
      return this.persistAndReturn(true)
    }

    // 2. Hard shell/path safety denials cannot be bypassed by allow rules.
    //    Prompt-only shell safety findings disable auto-allow but still let
    //    the user make the decision in the normal permission prompt.
    if (!requiresSafetyPrompt && allowedByRule) {
      this.denialStreaks.set(tool.name, 0)
      return this.persistAndReturn(true)
    }

    if (this.mode === 'auto') {
      // Fast-path 1: Safe read-only / metadata tools skip the classifier entirely
      if (isSafeAutoTool(tool.name)) {
        this.denialStreaks.set(tool.name, 0)
        return this.persistAndReturn(true)
      }

      // Fast-path 2: acceptEdits-style CWD file ops skip the classifier
      if (
        this.isAcceptEditsAllowed(tool, input, commandAnalysis)
        && !requiresSafetyPrompt
      ) {
        this.denialStreaks.set(tool.name, 0)
        return this.persistAndReturn(true)
      }

      // Layer 3: Rule-based classifier with user-configured allow/deny rules
      const autoDecision = classifyWithUserRules({
        tool,
        input,
        commandAnalysis,
        autoModeConfig: this.autoModeConfig,
        isLightWorkspaceShellWrite: (ca) => this.isLightWorkspaceShellWrite(ca),
        matchGlob: (content, pattern) => matchGlob(content, pattern),
        extractPath,
      })
      if (autoDecision.action === 'allow') {
        this.denialStreaks.set(tool.name, 0)
        return this.persistAndReturn(true)
      }
      if (autoDecision.action === 'deny') {
        const escalated = await this.handleAutoDeny(tool, input, commandAnalysis, true, autoDecision.source)
        if (escalated !== undefined) return this.persistAndReturn(escalated)
        return this.persistAndReturn(false)
      }
      return this.promptForDecision(
        tool,
        input,
        autoDecision.reason,
        autoDecision.source,
        false,
        { commandAnalysis },
      )
    }

    // 4. Prompt user
    return this.promptForDecision(
      tool,
      input,
      this.reasonFor(tool.riskLevel, commandAnalysis?.categories, false, this.denialStreaks.get(tool.name) ?? 0),
      this.promptSourceForNormalPrompt(commandAnalysis, requiresSafetyPrompt, allowedByRule),
      false,
      { matchedRule: allowedByRule, commandAnalysis },
    )
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
  ): Promise<boolean> {
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

    // 6. If user chose "always allow", add session rule
    if (approved && alwaysAllow && alwaysAllowRule) {
      this.addSessionRule(alwaysAllowRule)
    }

    return this.persistAndReturn(approved)
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

  getConfigRules(): PermissionRule[] {
    return [...this.configRules]
  }

  getSessionRules(): PermissionRule[] {
    return [...this.sessionRules]
  }

  getMode(): PermissionMode {
    return this.mode
  }

  getPrePlanMode(): PermissionMode {
    return this.prePlanMode
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
    // Strip dangerous permissions when entering auto mode so that overly
    // permissive allow rules cannot bypass the classifier.
    if (mode === 'auto') {
      this.stripDangerousPermissions()
    }
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

  /**
   * Remove dangerous allow rules that would bypass the auto mode classifier.
   * Called when entering auto mode to prevent overly permissive config rules
   * from silently approving dangerous operations (e.g. Bash without a content
   * pattern, or Agent tool which could spawn arbitrary sub-agents).
   */
  stripDangerousPermissions(): void {
    const isDangerous = (rule: PermissionRule): boolean => {
      if (rule.behavior !== 'allow') return false
      // Bash allow rules without a content pattern would approve ANY bash command
      if (rule.toolName === 'Bash' && !rule.contentPattern) return true
      // Agent allow rules could approve arbitrary sub-agent invocations
      if (rule.toolName === 'Agent') return true
      return false
    }

    this.configRules = this.configRules.filter((r) => !isDangerous(r))
    this.sessionRules = this.sessionRules.filter((r) => !isDangerous(r))
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
  ): PermissionRule | undefined {
    const allRules = [...this.configRules, ...this.sessionRules]
    return allRules.find((r) => r.behavior === behavior && this.matchesRule(r, toolName, input))
  }

  private matchesRule(rule: PermissionRule, toolName: string, input: unknown): boolean {
    if (rule.toolName !== toolName) return false
    if (!rule.contentPattern) return true
    const content = extractPath(input) || (typeof input === 'string' ? input : JSON.stringify(input))
    if (content === rule.contentPattern) return true
    return matchGlob(content, rule.contentPattern)
  }

  private addRules(rules: PermissionRule[]): void {
    for (const rule of rules) {
      if (rule.source === 'config') {
        this.configRules = dedupePermissionRules([...this.configRules, rule])
      } else {
        this.sessionRules = dedupePermissionRules([...this.sessionRules, rule])
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

  private isPlanAllowed(
    tool: Tool,
    input: unknown,
    commandAnalysis: ReturnType<typeof analyzeShellCommand> | undefined,
    hasHardSafetyDenial: boolean,
    requiresSafetyPrompt: boolean,
  ): boolean {
    if (tool.name === EXIT_PLAN_MODE_TOOL_NAME) return true
    if (tool.name === 'EnterPlanMode') return true
    if (tool.name === 'Agent' && isPlanAllowedAgent(input)) return true

    if (this.isAllowedPlanFileWrite(tool, input, requiresSafetyPrompt)) return true

    if (tool.isReadOnly === true) {
      return !hasHardSafetyDenial && !requiresSafetyPrompt
    }

    if (tool.name !== 'Bash' || !commandAnalysis) return false
    if (hasHardSafetyDenial || requiresSafetyPrompt || commandAnalysis.categories.length > 0) return false
    return isPlanReadOnlyShellCommand(commandAnalysis.command)
  }

  private isAllowedPlanFileWrite(tool: Tool, input: unknown, requiresSafetyPrompt: boolean): boolean {
    return (
      (tool.name === 'Write' || tool.name === 'Edit' || tool.name === 'MultiEdit')
      && !requiresSafetyPrompt
      && this.isSessionPlanFile(input)
    )
  }

  private isSessionPlanFile(input: unknown): boolean {
    const slug = this.planSlugProvider?.()
    if (!slug) return false
    const filePath = extractPath(input)
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
    if (ACCEPT_EDITS_TOOLS.has(tool.name)) return true
    if (tool.name !== 'Bash' || !commandAnalysis) return false
    return this.isLightWorkspaceShellWrite(commandAnalysis)
  }

  private isLightWorkspaceShellWrite(commandAnalysis: ReturnType<typeof analyzeShellCommand>): boolean {
    if (commandAnalysis.categories.length > 0) return false
    if (commandAnalysis.hasSafetyDenyIssue || commandAnalysis.requiresSafetyPrompt || commandAnalysis.hasProtectedPath) return false
    const words = shellWords(commandAnalysis.command)
    if (words.length === 0) return false
    const executable = basename(words[0]!).toLowerCase()
    if (!ACCEPT_EDITS_BASH_COMMANDS.has(executable)) return false
    const operands = words.slice(1).filter((word) => !word.startsWith('-'))
    if (operands.length === 0) return false
    return operands.every((operand) => this.isSafeWorkspacePathOperand(operand))
  }

  private isSafeWorkspacePathOperand(operand: string): boolean {
    if (operand === '.' || operand === '..') return false
    if (/[\0\r\n*?[\]{}$`~]/.test(operand)) return false
    if (isProtectedPath(operand)) return false
    const resolved = path.resolve(this.cwd, operand)
    const root = path.resolve(this.cwd)
    return resolved === root || resolved.startsWith(root + path.sep)
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
  ): PermissionDecisionSource {
    if (allowedByRule) return 'allow rule'
    if (requiresSafetyPrompt) return this.promptSourceForSafety(commandAnalysis, false)
    return 'mode'
  }

  private shouldOfferAlwaysAllow(source: PermissionDecisionSource): boolean {
    return this.mode !== 'bypass' && source === 'mode'
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
    const path = extractPath(input)
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

function isPlanAllowedAgent(input: unknown): boolean {
  if (!input || typeof input !== 'object') return false
  const subagentType = (input as { subagent_type?: unknown }).subagent_type
  return typeof subagentType === 'string' && PLAN_ALLOWED_AGENT_TYPES.has(subagentType)
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
