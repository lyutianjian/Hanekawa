import { randomUUID } from 'node:crypto'
import { PermissionGate } from './permissions.js'
import { runLifecycleHooks, runPreToolUseHooks } from './hooks.js'
import { validateToolInput } from './toolValidation.js'
import { countTextTokens } from '../prompts/budget.js'
import type { ToolHooks } from './hooks.js'
import type { SessionRecord, Tool, ToolCall, ToolContext, ToolErrorCode, ToolProgressEvent, ToolResultRecord, ToolUseRecord } from './types.js'

export interface ToolRunEvents {
  onRecord(record: SessionRecord): Promise<void>
  onProgress?(event: ToolProgressEvent): Promise<void> | void
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

  /**
   * Create a sibling ToolRunner that shares tools, permission gate, and hooks
   * but routes records and progress events to a different sink. The returned
   * runner has its own (empty) record-listener set, so any in-process listeners
   * registered on the original (e.g. AgentLoop's records cache invalidator) are
   * not invoked for forked runs. Use this when running a tool in isolation,
   * such as a diagnostic/verification call that must not pollute the main
   * session's record stream or in-memory caches.
   */
  fork(events: ToolRunEvents): ToolRunner {
    return new ToolRunner(this.tools, this.permissionGate, events, this.hooks)
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
    let progressStarted = false

    const executionContext: ToolContext = {
      ...context,
      abortSignal: signal ?? context.abortSignal,
      appendRecord: (record) => this.emitRecord(record),
      getPermissionMode: () => this.permissionGate.getMode(),
      setPermissionMode: (mode) => this.permissionGate.setMode(mode),
      exitPlanMode: () => this.permissionGate.exitPlanMode(),
    }

    try {
      await this.emitProgress({ call, phase: 'started' })
      progressStarted = true

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
          tool.maxResultSizeChars,
        )
        await this.emitToolResultAndPostHooks(record, tool, call.input, executionContext, signal)
        return record
      }

      const approved = await this.permissionGate.approve(tool, call.input)
      await this.emitRecord(this.permissionGate.createApprovalRecord(tool, call.input, approved, turnId))
      if (!approved) {
        const denied = this.result(call, tool.name, false, `User denied permission for ${tool.name}.`, 'permission_denied', undefined, turnId, tool.maxResultSizeChars)
        await this.emitToolResultAndPostHooks(denied, tool, call.input, executionContext, signal)
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
          tool.maxResultSizeChars,
        )
        await this.emitToolResultAndPostHooks(blocked, tool, call.input, executionContext, signal)
        return blocked
      }

      try {
        const result = await tool.execute(call.input, executionContext)
        syncMutableToolContext(context, executionContext)
        const record = this.result(call, tool.name, result.ok, result.content, result.errorCode, result.errorDetails, turnId, tool.maxResultSizeChars)
        await this.emitToolResultAndPostHooks(record, tool, call.input, executionContext, signal)
        await this.emitAssistantMessageFromMetadata(result.metadata, turnId)
        return record
      } catch (error) {
        syncMutableToolContext(context, executionContext)
        const errorCode = error instanceof Error && error.name === 'AbortError' ? 'aborted' : 'execution_failed'
        const record = this.result(call, tool.name, false, error instanceof Error ? error.message : String(error), errorCode, undefined, turnId, tool.maxResultSizeChars)
        await this.emitToolResultAndPostHooks(record, tool, call.input, executionContext, signal)
        return record
      }
    } catch (error) {
      if (!isAbortError(error)) {
        throw error
      }
      syncMutableToolContext(context, executionContext)
      const record = this.result(call, tool.name, false, error instanceof Error ? error.message : String(error), 'aborted', undefined, turnId, tool.maxResultSizeChars)
      await this.emitToolResultAndPostHooks(record, tool, call.input, executionContext, signal)
      return record
    } finally {
      if (progressStarted) {
        await this.emitProgress({ call, phase: 'finished' })
      }
    }
  }

  private async emitRecord(record: SessionRecord): Promise<void> {
    await this.events.onRecord(record)
    for (const listener of this.recordListeners) {
      listener(record)
    }
  }

  private async emitProgress(event: ToolProgressEvent): Promise<void> {
    try {
      await this.events.onProgress?.(event)
    } catch {
      // Progress updates are UI-only; tool execution and persistence own truth.
    }
  }

  private async emitToolResultAndPostHooks(
    record: ToolResultRecord,
    tool: Tool,
    input: unknown,
    context: ToolContext,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.emitRecord(record)
    const result = await runLifecycleHooks(
      this.hooks.postToolUse,
      'postToolUse',
      {
        tool: tool.name,
        riskLevel: tool.riskLevel,
        input,
        result: {
          ok: record.ok,
          content: record.content,
          errorCode: record.errorCode,
          errorDetails: record.errorDetails,
        },
        toolUseId: record.toolUseId,
      },
      context,
      signal,
      tool.name,
    )
    await this.emitPostToolUseHookMessage(tool.name, result, record.turnId)
  }

  private async emitPostToolUseHookMessage(
    toolName: string,
    result: Awaited<ReturnType<typeof runLifecycleHooks>>,
    turnId?: string,
  ): Promise<void> {
    const blocks: string[] = []
    if (result.stdout.trim()) blocks.push(result.stdout.trim())
    if (result.failures.length > 0) blocks.push(`Hook failures:\n${result.failures.join('\n')}`)
    if (result.blockingErrors.length > 0) blocks.push(`Hook blocking errors:\n${result.blockingErrors.join('\n')}`)
    if (blocks.length === 0) return

    await this.emitRecord({
      id: randomUUID(),
      type: 'message',
      role: 'user',
      content: `<system-reminder>postToolUse hook output for ${toolName}:\n${blocks.join('\n\n')}</system-reminder>`,
      ...(turnId ? { turnId } : {}),
      createdAt: new Date().toISOString(),
    })
  }

  private result(
    call: ToolCall,
    tool: string,
    ok: boolean,
    content: string,
    errorCode?: ToolErrorCode,
    errorDetails?: unknown,
    turnId?: string,
    maxResultSizeChars?: number,
  ): ToolResultRecord {
    const boundedContent = applyToolResultBudget(content, maxResultSizeChars)
    return {
      id: randomUUID(),
      type: 'tool_result',
      toolUseId: call.id,
      tool,
      ok,
      content: boundedContent,
      _tokens: countTextTokens(`${tool}\n${boundedContent}`),
      ...(errorCode ? { errorCode } : {}),
      ...(errorDetails !== undefined ? { errorDetails } : {}),
      ...(turnId ? { turnId } : {}),
      createdAt: new Date().toISOString(),
    }
  }

  private async emitAssistantMessageFromMetadata(metadata: Record<string, unknown> | undefined, turnId?: string): Promise<void> {
    const content = metadata?.assistantMessageContent
    if (typeof content === 'string' && content.trim().length > 0) {
      await this.emitRecord({
        id: randomUUID(),
        type: 'message',
        role: 'assistant',
        content,
        ...(turnId ? { turnId } : {}),
        createdAt: new Date().toISOString(),
      })
    }

    const subagentSummary = formatSubagentSummary(metadata?.subagent)
    if (!subagentSummary) return
    await this.emitRecord({
      id: randomUUID(),
      type: 'message',
      role: 'assistant',
      content: subagentSummary,
      ...(turnId ? { turnId } : {}),
      createdAt: new Date().toISOString(),
    })
  }
}

function formatSubagentSummary(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined
  const type = typeof value.type === 'string' ? value.type : undefined
  if (!type) return undefined

  const attributes: string[] = [`type="${escapeAttribute(type)}"`]
  const agentId = typeof value.agentId === 'string' ? value.agentId : undefined
  if (agentId) attributes.push(`agent_id="${escapeAttribute(agentId)}"`)

  const verdict = typeof value.verdict === 'string' ? value.verdict : undefined
  if (verdict) attributes.push(`verdict="${escapeAttribute(verdict)}"`)

  const usage = isRecord(value.usage) ? value.usage : undefined
  const tokens = usage ? totalTokens(usage) : undefined
  if (tokens !== undefined) attributes.push(`tokens="${tokens}"`)

  const criticalFiles = Array.isArray(value.criticalFiles)
    ? value.criticalFiles.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : []
  if (criticalFiles.length > 0) {
    attributes.push(`critical_files="${escapeAttribute(criticalFiles.join(','))}"`)
  }

  return `<subagent-summary ${attributes.join(' ')} />`
}

function totalTokens(usage: Record<string, unknown>): number | undefined {
  const inputTokens = numericUsageField(usage.inputTokens)
  const cacheReadInputTokens = numericUsageField(usage.cacheReadInputTokens)
  const outputTokens = numericUsageField(usage.outputTokens)
  if (inputTokens === undefined || cacheReadInputTokens === undefined || outputTokens === undefined) return undefined
  return inputTokens + cacheReadInputTokens + outputTokens
}

function numericUsageField(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function syncMutableToolContext(target: ToolContext, source: ToolContext): void {
  target.readFileState = source.readFileState
  target.invokedSkills = source.invokedSkills
  target.taskState = source.taskState
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

function applyToolResultBudget(content: string, maxResultSizeChars: number | undefined): string {
  if (maxResultSizeChars === undefined || content.length <= maxResultSizeChars) return content
  return [
    content.slice(0, maxResultSizeChars),
    `[Tool result truncated: exceeded ${maxResultSizeChars} chars; original ${content.length} chars]`,
  ].join('\n\n')
}
