import { randomUUID } from 'node:crypto'
import { PermissionGate } from './permissions.js'
import type { SessionRecord, Tool, ToolCall, ToolContext, ToolResultRecord, ToolUseRecord } from './types.js'

export interface ToolRunEvents {
  onRecord(record: SessionRecord): Promise<void>
}

export class ToolRunner {
  constructor(
    private readonly tools: Tool[],
    private readonly permissionGate: PermissionGate,
    private readonly events: ToolRunEvents,
  ) {}

  async run(call: ToolCall, context: ToolContext): Promise<ToolResultRecord> {
    const tool = this.tools.find((candidate) => candidate.name === call.name)
    if (!tool) throw new Error(`Unknown tool: ${call.name}`)

    const toolUse: ToolUseRecord = {
      id: call.id,
      type: 'tool_use',
      tool: tool.name,
      input: call.input,
      riskLevel: tool.riskLevel,
      createdAt: new Date().toISOString(),
    }
    await this.events.onRecord(toolUse)

    const approved = await this.permissionGate.approve(tool, call.input)
    await this.events.onRecord(this.permissionGate.createApprovalRecord(tool, call.input, approved))
    if (!approved) {
      const denied = this.result(call, tool.name, false, `User denied permission for ${tool.name}.`)
      await this.events.onRecord(denied)
      return denied
    }

    try {
      const result = await tool.execute(call.input, context)
      const record = this.result(call, tool.name, result.ok, result.content)
      await this.events.onRecord(record)
      return record
    } catch (error) {
      const record = this.result(call, tool.name, false, error instanceof Error ? error.message : String(error))
      await this.events.onRecord(record)
      return record
    }
  }

  private result(call: ToolCall, tool: string, ok: boolean, content: string): ToolResultRecord {
    return {
      id: randomUUID(),
      type: 'tool_result',
      toolUseId: call.id,
      tool,
      ok,
      content,
      createdAt: new Date().toISOString(),
    }
  }
}
