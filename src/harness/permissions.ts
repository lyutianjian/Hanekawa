import { randomUUID } from 'node:crypto'
import { analyzeShellCommand } from './commandAnalysis.js'
import { shellWords } from './bashSafety.js'
import type { RiskLevel, Tool, ToolApprovalRecord } from './types.js'
import { isProtectedPath } from '../utils/permissions/protectedPaths.js'
import { EXIT_PLAN_MODE_TOOL_NAME } from '../tools/toolNames.js'

export type PermissionMode = 'default' | 'plan' | 'acceptEdits' | 'auto' | 'bypass'

export interface PermissionRequest {
  tool: Tool
  input: unknown
  reason: string
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
  behavior: 'allow' | 'deny'
  source: 'session' | 'config'
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

export { isProtectedPath } from '../utils/permissions/protectedPaths.js'

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

function matchGlob(content: string, pattern: string): boolean {
  // Simple glob matching: * matches any characters
  const regexPattern = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.')
  return new RegExp(`^${regexPattern}$`, 'i').test(content)
}

export class PermissionGate {
  private sessionRules: PermissionRule[] = []
  private configRules: PermissionRule[] = []
  private mode: PermissionMode
  private prePlanMode: PermissionMode = 'default'
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
    },
  ) {
    this.configRules = [...(configRules ?? [])]
    this.mode = options?.mode ?? 'default'
    const configured = options?.denialStreakThreshold ?? DEFAULT_DENIAL_STREAK_THRESHOLD
    this.denialStreakThreshold = Math.max(1, configured)
    const globalConfigured = options?.globalDenialPromptThreshold ?? DEFAULT_GLOBAL_DENIAL_PROMPT_THRESHOLD
    this.globalDenialPromptThreshold = Math.max(1, globalConfigured)
    this.denialStateStore = options?.denialStateStore
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

    const deniedByRule = this.isDenied(tool.name, input)

    if (this.mode === 'bypass') {
      if (hasProtectedPath) {
        const approved = await this.prompt({
          tool,
          input,
          reason: this.protectedPathBypassReason(input, commandAnalysis),
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
        let alwaysAllow = false
        const approved = await this.prompt({
          tool,
          input,
          reason: this.reasonFor(tool.riskLevel, commandAnalysis?.categories, false, previousStreak),
          denialStreak: 0,
          onAlwaysAllow: () => { alwaysAllow = true },
        })
        this.recordPromptDecision(tool.name, approved, previousStreak)
        if (approved && alwaysAllow) {
          this.addSessionRule({ toolName: tool.name, behavior: 'allow', source: 'session' })
        }
        return this.persistAndReturn(approved)
      }

      this.denialStreaks.set(tool.name, 0)
      return this.persistAndReturn(true)
    }

    if (this.mode === 'plan') {
      if (this.isPlanAllowed(tool, commandAnalysis, hasHardSafetyDenial, requiresSafetyPrompt)) {
        this.denialStreaks.set(tool.name, 0)
        return this.persistAndReturn(true)
      }
      this.denialStreaks.set(tool.name, 0)
      return this.persistAndReturn(false)
    }

    if (
      this.mode === 'acceptEdits'
      && this.isAcceptEditsAllowed(tool)
      && !hasHardSafetyDenial
      && !requiresSafetyPrompt
      && !deniedByRule
    ) {
      this.denialStreaks.set(tool.name, 0)
      return this.persistAndReturn(true)
    }

    if (tool.riskLevel === 'safe' && !hasHardSafetyDenial && !requiresSafetyPrompt) {
      this.denialStreaks.set(tool.name, 0)
      return this.persistAndReturn(true)
    }

    const wouldAutoDeny = hasHardSafetyDenial || deniedByRule

    // 2. Hard shell/path safety denials cannot be bypassed by allow rules.
    //    Prompt-only shell safety findings disable auto-allow but still let
    //    the user make the decision in the normal permission prompt.
    if (!hasHardSafetyDenial && !requiresSafetyPrompt && this.isAllowed(tool.name, input)) {
      this.denialStreaks.set(tool.name, 0)
      return this.persistAndReturn(true)
    }

    if (
      this.mode === 'auto'
      && tool.riskLevel === 'confirm'
      && !hasHardSafetyDenial
      && !requiresSafetyPrompt
      && !deniedByRule
    ) {
      this.denialStreaks.set(tool.name, 0)
      return this.persistAndReturn(true)
    }

    // 3. Auto-deny path - but if the same tool has been auto-denied
    //    consecutively too many times, escalate to a user prompt instead so
    //    the model cannot loop on a blocked call indefinitely.
    if (wouldAutoDeny) {
      const escalated = await this.handleAutoDeny(tool, input, commandAnalysis, wouldAutoDeny)
      if (escalated !== undefined) return this.persistAndReturn(escalated)
    }

    // 4. Prompt user
    const previousStreak = this.denialStreaks.get(tool.name) ?? 0
    const reason = this.reasonFor(tool.riskLevel, commandAnalysis?.categories, wouldAutoDeny, previousStreak)
    let alwaysAllow = false
    const approved = await this.prompt({
      tool,
      input,
      reason,
      denialStreak: wouldAutoDeny ? previousStreak + 1 : 0,
      onAlwaysAllow: () => { alwaysAllow = true },
    })

    // 5. Decision recorded. Explicit approval clears the loop signal. Explicit
    //    denial keeps it near the threshold so repeated requests keep prompting
    //    instead of falling back to silent auto-denial.
    this.recordPromptDecision(tool.name, approved, previousStreak)

    // 6. If user chose "always allow", add session rule
    if (approved && alwaysAllow) {
      this.addSessionRule({
        toolName: tool.name,
        behavior: 'allow',
        source: 'session',
      })
    }

    return this.persistAndReturn(approved)
  }

  addSessionRule(rule: PermissionRule): void {
    this.sessionRules.push(rule)
  }

  setConfigRules(rules: PermissionRule[]): void {
    this.configRules = [...rules]
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

  private isDenied(toolName: string, input: unknown): boolean {
    const allRules = [...this.configRules, ...this.sessionRules]
    return allRules.some(
      (r) => r.behavior === 'deny' && this.matchesRule(r, toolName, input),
    )
  }

  private isAllowed(toolName: string, input: unknown): boolean {
    const allRules = [...this.configRules, ...this.sessionRules]
    return allRules.some(
      (r) => r.behavior === 'allow' && this.matchesRule(r, toolName, input),
    )
  }

  private matchesRule(rule: PermissionRule, toolName: string, input: unknown): boolean {
    if (rule.toolName !== toolName) return false
    if (!rule.contentPattern) return true
    const content = typeof input === 'string' ? input : JSON.stringify(input)
    return matchGlob(content, rule.contentPattern)
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
    let alwaysAllow = false
    const approved = await this.prompt({
      tool,
      input,
      reason,
      denialStreak: previousStreak + 1,
      onAlwaysAllow: () => { alwaysAllow = true },
    })

    this.recordPromptDecision(tool.name, approved, previousStreak)

    if (approved && alwaysAllow && this.mode !== 'bypass') {
      this.addSessionRule({
        toolName: tool.name,
        behavior: 'allow',
        source: 'session',
      })
    }

    return approved
  }

  private isPlanAllowed(
    tool: Tool,
    commandAnalysis: ReturnType<typeof analyzeShellCommand> | undefined,
    hasHardSafetyDenial: boolean,
    requiresSafetyPrompt: boolean,
  ): boolean {
    if (tool.name === EXIT_PLAN_MODE_TOOL_NAME) return true

    if (tool.isReadOnly === true) {
      return !hasHardSafetyDenial && !requiresSafetyPrompt
    }

    if (tool.name !== 'Bash' || !commandAnalysis) return false
    if (hasHardSafetyDenial || requiresSafetyPrompt || commandAnalysis.categories.length > 0) return false
    return isPlanReadOnlyShellCommand(commandAnalysis.command)
  }

  private isAcceptEditsAllowed(tool: Tool): boolean {
    return ACCEPT_EDITS_TOOLS.has(tool.name)
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

function isPlanReadOnlyShellCommand(command: string): boolean {
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

function basename(command: string): string {
  const normalized = command.replace(/\\/g, '/')
  const slash = normalized.lastIndexOf('/')
  return slash === -1 ? normalized : normalized.slice(slash + 1)
}
