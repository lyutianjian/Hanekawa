import { randomUUID } from 'node:crypto'
import type { RiskLevel, Tool, ToolApprovalRecord } from './types.js'

export interface PermissionRequest {
  tool: Tool
  input: unknown
  reason: string
}

export type PermissionPrompt = (request: PermissionRequest) => Promise<boolean>

export class PermissionGate {
  constructor(private readonly prompt: PermissionPrompt) {}

  async approve(tool: Tool, input: unknown): Promise<boolean> {
    if (tool.riskLevel === 'safe') return true
    const reason = this.reasonFor(tool.riskLevel)
    return this.prompt({ tool, input, reason })
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

  private reasonFor(riskLevel: RiskLevel): string {
    if (riskLevel === 'confirm') return 'This action changes local state and requires confirmation.'
    return 'This is a dangerous action and requires explicit confirmation.'
  }
}
