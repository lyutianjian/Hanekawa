import { randomUUID } from 'node:crypto'
import { PermissionGate } from './permissions.js'
import { runPreToolUseHooks } from './hooks.js'
import { validateToolInput } from './toolValidation.js'
import { countTextTokens } from '../prompts/budget.js'
import type { ToolHooks } from './hooks.js'
import type { SessionRecord, Tool, ToolCall, ToolContext, ToolErrorCode, ToolResultRecord, ToolUseRecord } from './types.js'

export interface ToolRunEvents {
  onRecord(record: SessionRecord): Promise<void>
}

type ToolRunRecordListener = (record: SessionRecord) => void

export class ToolRunner {
  private readonly recordListeners = new Set<ToolRunRecordListener>()

  constructor(
    private readonly tools: Tool[],
    private readonly permissionGate: PermissionGate,
    private readonly events: ToolRunEvents,
    private readonly hooks: ToolHooks = {},
  ) {}

  addRecordListener(listener: ToolRunRecordListener): () => void {
    this.recordListeners.add(listener)
    return () => {
      this.recordListeners.delete(listener)
    }
  }

  async run(call: ToolCall, context: ToolContext, signal?: AbortSignal, turnId?: string): Promise<ToolResultRecord> {
    if (signal?.aborted) {
      throw new DOMException('The operation was aborted.', 'AbortError')
    }

    const tool = this.tools.find((candidate) => candidate.name === call.name)
    if (!tool) throw new Error(`Unknown tool: ${call.name}`)

    const toolUse: ToolUseRecord = {
      id: call.id,
      type: 'tool_use',
      tool: tool.name,
      input: call.input,
      riskLevel: tool.riskLevel,
      ...(turnId ? { turnId } : {}),
      createdAt: new Date().toISOString(),
    }
    await this.emitRecord(toolUse)

    const executionContext: ToolContext = {
      ...context,
      abortSignal: signal ?? context.abortSignal,
    }

    try {
      if (signal?.aborted) {
        throw new DOMException('The operation was aborted.', 'AbortError')
      }

      const validation = validateToolInput(tool, call.input)
      if (!validation.ok) {
        const firstError = validation.errors[0]
        const record = this.result(
          call,
          tool.name,
          false,
          `Tool input validation failed for ${tool.name}: ${firstError?.message ?? 'invalid input'}`,
          'invalid_input',
          validation.errors,
          turnId,
        )
        await this.emitRecord(record)
        return record
      }

      const approved = await this.permissionGate.approve(tool, call.input)
      await this.emitRecord(this.permissionGate.createApprovalRecord(tool, call.input, approved, turnId))
      if (!approved) {
        const denied = this.result(call, tool.name, false, `User denied permission for ${tool.name}.`, 'permission_denied', undefined, turnId)
        await this.emitRecord(denied)
        return denied
      }

      const preToolHooks = await runPreToolUseHooks(this.hooks.preToolUse, tool, call.input, executionContext, signal)
      syncMutableToolContext(context, executionContext)
      if (!preToolHooks.ok) {
        const blocked = this.result(
          call,
          tool.name,
          false,
          preToolHooks.content ?? `Pre-tool hook blocked ${tool.name}.`,
          'precondition_failed',
          preToolHooks.details,
          turnId,
        )
        await this.emitRecord(blocked)
        return blocked
      }

      try {
        const result = await tool.execute(call.input, executionContext)
        syncMutableToolContext(context, executionContext)
        const record = this.result(call, tool.name, result.ok, result.content, result.errorCode, result.errorDetails, turnId)
        await this.emitRecord(record)
        return record
      } catch (error) {
        syncMutableToolContext(context, executionContext)
        const errorCode = error instanceof Error && error.name === 'AbortError' ? 'aborted' : 'execution_failed'
        const record = this.result(call, tool.name, false, error instanceof Error ? error.message : String(error), errorCode, undefined, turnId)
        await this.emitRecord(record)
        return record
      }
    } catch (error) {
      if (!isAbortError(error)) {
        throw error
      }
      syncMutableToolContext(context, executionContext)
      const record = this.result(call, tool.name, false, error instanceof Error ? error.message : String(error), 'aborted', undefined, turnId)
      await this.emitRecord(record)
      return record
    }
  }

  private async emitRecord(record: SessionRecord): Promise<void> {
    await this.events.onRecord(record)
    for (const listener of this.recordListeners) {
      listener(record)
    }
  }

  private result(
    call: ToolCall,
    tool: string,
    ok: boolean,
    content: string,
    errorCode?: ToolErrorCode,
    errorDetails?: unknown,
    turnId?: string,
  ): ToolResultRecord {
    return {
      id: randomUUID(),
      type: 'tool_result',
      toolUseId: call.id,
      tool,
      ok,
      content,
      _tokens: countTextTokens(`${tool}\n${content}`),
      ...(errorCode ? { errorCode } : {}),
      ...(errorDetails !== undefined ? { errorDetails } : {}),
      ...(turnId ? { turnId } : {}),
      createdAt: new Date().toISOString(),
    }
  }
}

function syncMutableToolContext(target: ToolContext, source: ToolContext): void {
  target.readFileState = source.readFileState
  target.invokedSkills = source.invokedSkills
  target.taskState = source.taskState
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}
