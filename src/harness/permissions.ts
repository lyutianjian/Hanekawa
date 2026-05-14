import { randomUUID } from 'node:crypto'
import type { RiskLevel, Tool, ToolApprovalRecord } from './types.js'

export interface PermissionRequest {
  tool: Tool
  input: unknown
  reason: string
  onAlwaysAllow?: () => void
}

export type PermissionPrompt = (request: PermissionRequest) => Promise<boolean>

export interface PermissionRule {
  toolName: string
  contentPattern?: string
  behavior: 'allow' | 'deny'
  source: 'session' | 'config'
}

const PROTECTED_PATHS = ['.git', '.myagent', '.env', '.ssh']
const PROTECTED_FILES = ['.gitconfig', '.bashrc', '.zshrc', '.env', '.npmrc']

function isProtectedPath(path: string): boolean {
  const normalized = path.replace(/\\/g, '/')
  return PROTECTED_PATHS.some((p) => normalized.includes(`/${p}/`))
    || PROTECTED_FILES.some((f) => normalized.endsWith(`/${f}`))
}

function extractPath(input: unknown): string {
  if (typeof input === 'string') return input
  if (input && typeof input === 'object') {
    const obj = input as Record<string, unknown>
    if (typeof obj.path === 'string') return obj.path
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

  constructor(
    private readonly prompt: PermissionPrompt,
    configRules?: PermissionRule[],
  ) {
    this.configRules = configRules ?? []
  }

  async approve(tool: Tool, input: unknown): Promise<boolean> {
    // 1. Safe tools are always approved
    if (tool.riskLevel === 'safe') return true

    // 2. Check deny rules
    if (this.isDenied(tool.name, input)) return false

    // 3. Check allow rules
    if (this.isAllowed(tool.name, input)) return true

    // 4. Check file system protection
    const path = extractPath(input)
    if (path && isProtectedPath(path)) return false

    // 5. Prompt user
    const reason = this.reasonFor(tool.riskLevel)
    let alwaysAllow = false
    const approved = await this.prompt({
      tool,
      input,
      reason,
      onAlwaysAllow: () => { alwaysAllow = true },
    })

    // 6. If user chose "always allow", add session rule
    if (approved && alwaysAllow) {
      this.addSessionRule({
        toolName: tool.name,
        behavior: 'allow',
        source: 'session',
      })
    }

    return approved
  }

  addSessionRule(rule: PermissionRule): void {
    this.sessionRules.push(rule)
  }

  setConfigRules(rules: PermissionRule[]): void {
    this.configRules = rules
  }

  createApprovalRecord(tool: Tool, input: unknown, approved: boolean): ToolApprovalRecord {
    return {
      id: randomUUID(),
      type: 'tool_approval',
      tool: tool.name,
      input,
      approved,
      riskLevel: tool.riskLevel,
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

  private reasonFor(riskLevel: RiskLevel): string {
    if (riskLevel === 'confirm') return 'This action changes local state and requires confirmation.'
    return 'This is a dangerous action and requires explicit confirmation.'
  }
}
