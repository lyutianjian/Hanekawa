import { randomUUID } from 'node:crypto'
import os from 'node:os'
import { ContextBuilder } from './contextBuilder.js'
import type { EnvironmentInfo } from './contextBuilder.js'
import { ToolRunner } from './toolRunner.js'
import { EMPTY_TOKEN_USAGE, addTokenUsage } from './usage.js'
import { autoCompactIfNeeded } from './compact.js'
import {
  prepareRecordsForRequestWithDiagnostics,
  requestTokenCountFromUsage,
} from './requestPrep.js'
import { agentCacheSource, formatCacheHitRate, notifyCompaction, resetCacheBreakDetection } from './cacheBreakDetection.js'
import { logDiagnostics, type RuntimeDiagnostic } from './diagnostics.js'
import { cacheHitRate, type SessionMetricInput } from './metrics.js'
import type { RecordStream } from './recordStream.js'
import { runLifecycleHooks, type Hooks } from './hooks.js'
import { FallbackTriggeredError } from '../config/retry.js'
import type { ContextManagementConfig } from '../prompts/budget.js'
import type { SkillDefinition } from '../services/skills/skillsService.js'
import type { CacheRuntime } from './cacheControl.js'
import type { AgentRunResult, ChatMessage, ModelProvider, SessionRecord, Tool, ToolCall, ToolContext, ToolResultRecord, TokenUsage } from './types.js'

export interface ActiveModelRuntime {
  provider: ModelProvider
  model: string
  modelKey?: string
  providerName?: string
  promptCacheRetention?: 'in_memory' | '24h'
}

export interface AgentLoopOptions {
  provider: ModelProvider
  model: string
  modelKey?: string
  tools: Tool[]
  contextBuilder: ContextBuilder
  toolRunner: ToolRunner
  toolContext: ToolContext
  system?: string
  projectContext?: string
  skills?: SkillDefinition[]
  promptCacheRetention?: 'in_memory' | '24h'
  contextManagement?: Partial<ContextManagementConfig>
  isGitRepo?: boolean
  maxTurns?: number
  tokenBudget?: number
  tokenWarningThreshold?: number
  fallbackModel?: ActiveModelRuntime
  fallbackRetryDelayMs?: number
  hooks?: Hooks
  cacheRuntime?: CacheRuntime
  getCompactFailureCount?(): Promise<number>
  setCompactFailureCount?(count: number): Promise<void>
  recordStream: RecordStream
  onRecord?(record: SessionRecord): void
}

const ESCALATED_MAX_TOKENS = 64_000
const MAX_RECOVERY_COUNT = 3
const DEFAULT_FALLBACK_RETRY_DELAY_MS = 5 * 60 * 1000

export class AgentLoop {
  private readonly modelState: {
    current: ActiveModelRuntime
    primary: ActiveModelRuntime
    fallback?: ActiveModelRuntime
    fallbackActivatedAt?: number
  }
  private recordsCache: SessionRecord[] | undefined
  private recordsCacheHasCleanToolProtocol = false
  private stripAllThinkingBlocksFromRequests = false

  constructor(private readonly options: AgentLoopOptions) {
    const primary = {
      provider: options.provider,
      model: options.model,
      modelKey: options.modelKey,
      providerName: options.provider.name,
      promptCacheRetention: options.promptCacheRetention,
    }
    this.modelState = {
      current: primary,
      primary,
      fallback: options.fallbackModel,
    }
    this.options.toolRunner.addRecordListener((record) => {
      this.noteRecordAppended(record)
    })
  }

  getActiveModel(): Omit<ActiveModelRuntime, 'provider'> {
    return {
      model: this.activeModel.model,
      modelKey: this.activeModel.modelKey,
      providerName: this.activeModel.providerName,
      promptCacheRetention: this.activeModel.promptCacheRetention,
    }
  }

  clearCachedSections(key?: string): void {
    this.options.contextBuilder.clearCachedSections(key)
  }

  invalidateAvailableToolsSection(): void {
    this.options.contextBuilder.invalidateAvailableToolsSection()
  }

  invalidateRecordsCache(): void {
    this.recordsCache = undefined
    this.recordsCacheHasCleanToolProtocol = false
  }

  noteRecordAppended(record: SessionRecord): void {
    this.recordsCache?.push(record)
  }

  async run(userInput: string, signal?: AbortSignal, messageId?: string): Promise<AgentRunResult> {
    const turnStartedAt = Date.now()
    let usage = { ...EMPTY_TOKEN_USAGE }
    let turnResponseUsage = { ...EMPTY_TOKEN_USAGE }
    let turnToolCalls = 0
    const turnId = randomUUID()
    const userMessage: ChatMessage & { type: 'message' } = {
      type: 'message',
      id: messageId ?? randomUUID(),
      role: 'user',
      content: userInput,
      turnId,
      createdAt: new Date().toISOString(),
    }
    await this.appendRecord(userMessage)
    await this.runUserPromptSubmitHooks(userInput, turnId, signal)
    let lastResponseTokenCount: number | undefined

    const maxTurns = this.options.maxTurns ?? 100
    const tokenBudget = this.options.tokenBudget
    const tokenWarnThreshold = this.options.tokenWarningThreshold ?? 0.8
    const cacheSource = agentCacheSource(this.options.toolContext.sessionId)

    let lastRequestId: string | undefined
    let maxOutputTokensOverride: number | undefined
    let maxOutputTokensRecoveryCount = 0

    for (let iteration = 0; iteration < maxTurns; iteration++) {
      // Check abort signal at the start of each iteration
      if (signal?.aborted) {
        throw new DOMException('The operation was aborted.', 'AbortError')
      }
      let recordsBeforeCompact = await this.loadPreparedRecords()
      const compactResult = await autoCompactIfNeeded({
        records: recordsBeforeCompact,
        provider: this.activeModel.provider,
        model: this.activeModel.model,
        tools: this.options.tools,
        system: this.options.system,
        contextManagement: this.options.contextManagement,
        lastResponseTokenCount,
        promptCacheRetention: this.activeModel.promptCacheRetention,
        turnId,
        circuitKey: this.options.toolContext.sessionId,
        getCompactFailureCount: this.options.getCompactFailureCount,
        setCompactFailureCount: this.options.setCompactFailureCount,
        appendRecord: (record) => this.appendRecord(record),
      })
      usage = addTokenUsage(usage, compactResult.usage)
      if (compactResult.compacted) {
        notifyCompaction(cacheSource)
        this.options.contextBuilder.clearCachedSections()
        if (compactResult.metrics) {
          await this.emitMetric({
            event: 'compact',
            model: this.activeModel.model,
            pre_tokens: compactResult.metrics.preTokens,
            post_tokens: compactResult.metrics.postTokens,
            compact_duration_ms: compactResult.metrics.compactDurationMs,
          })
        }
      }

      if (this.retryPrimaryIfReady(cacheSource)) {
        lastRequestId = undefined
        maxOutputTokensOverride = undefined
        recordsBeforeCompact = await this.loadPreparedRecords()
      }

      const records = recordsBeforeCompact
      const pendingRestoreRecordIds = this.pendingPostCompactRestoreRecordIds(records)
      const env: EnvironmentInfo = {
        cwd: this.options.toolContext.cwd,
        platform: process.platform,
        shell: process.env.SHELL ?? (process.platform === 'win32' ? 'powershell' : 'bash'),
        osVersion: `${os.type()} ${os.release()}`,
        isGitRepo: this.options.isGitRepo ?? false,
        model: this.activeModel.model,
      }

      const built = await this.options.contextBuilder.build({
        records,
        tools: this.options.tools,
        system: this.options.system,
        projectContext: this.options.projectContext,
        skills: this.options.skills,
        toolContext: this.options.toolContext,
        env,
        includePostCompactRestore: pendingRestoreRecordIds.length > 0,
      })
      await this.consumePostCompactRestoreRecords(pendingRestoreRecordIds)

      const modelRequest = {
        system: built.system,
        systemBlocks: built.systemBlocks,
        messages: built.messages,
        contextItems: built.contextItems,
        tools: this.options.tools,
        model: this.activeModel.model,
        promptCacheRetention: this.activeModel.promptCacheRetention,
        maxOutputTokens: maxOutputTokensOverride,
        previousRequestId: lastRequestId,
        retry: { signal },
        cacheSource,
        cacheRuntime: this.options.cacheRuntime,
      }

      let response
      try {
        response = await this.activeModel.provider.createMessage(modelRequest)
      } catch (error) {
        if (error instanceof FallbackTriggeredError && this.activateFallback(cacheSource)) {
          lastRequestId = undefined
          maxOutputTokensOverride = undefined
          continue
        }
        throw error
      }

      usage = addTokenUsage(usage, response.usage)
      turnResponseUsage = addTokenUsage(turnResponseUsage, response.usage)
      turnToolCalls += response.toolCalls.length
      lastResponseTokenCount = requestTokenCountFromUsage(response.usage)
      lastRequestId = response.requestId
      if (response.cacheBreak) {
        await this.emitMetric({
          event: 'cache_break',
          source: response.cacheBreak.source,
          reasons: response.cacheBreak.reasons,
          drop_tokens: response.cacheBreak.tokenDrop,
        })
      }

      if (response.usage) {
        // Cache-break detection itself is owned by anthropicProvider via
        // checkResponseForCacheBreak (cause-aware). Loop only emits the
        // hit-rate summary for debug visibility on every provider.
        if (process.env.MYAGENT_DEBUG_PROVIDER === '1') {
          console.error(`[hanekawa][cache] ${formatCacheHitRate(response.usage)}`)
        }
      }

      // max_output_tokens escalation: retry with higher limit
      if (response.stopReason === 'max_tokens') {
        if (maxOutputTokensOverride === undefined) {
          maxOutputTokensOverride = ESCALATED_MAX_TOKENS
          continue
        }

        if (maxOutputTokensRecoveryCount < MAX_RECOVERY_COUNT) {
          await this.appendRecord({
            type: 'message',
            id: randomUUID(),
            role: 'user',
            content: '<system-reminder>Your previous response was cut off by the token limit. Continue from where you left off.</system-reminder>',
            turnId,
            createdAt: new Date().toISOString(),
          })
          maxOutputTokensRecoveryCount++
          continue
        }
      }

      // Token budget check
      const cumulativeTokens = requestTokenCountFromUsage(usage) ?? 0
      if (tokenBudget && cumulativeTokens > tokenBudget) {
        const finished = await this.finishTurn({
          content: `${response.content}\n\n[Token budget exceeded: ${cumulativeTokens} > ${tokenBudget}]`,
          usage,
          turnId,
          turnStartedAt,
          turnResponseUsage,
          turnToolCalls,
          signal,
        })
        if (finished.continueLoop) continue
        return finished.result
      }

      // Token warning
      if (
        tokenBudget &&
        cumulativeTokens > tokenBudget * tokenWarnThreshold &&
        response.toolCalls.length > 0
      ) {
        const pct = Math.round((cumulativeTokens / tokenBudget) * 100)
        await this.appendRecord({
          type: 'message',
          id: randomUUID(),
          role: 'user',
          content: `<system-reminder>Token budget at ${pct}%. Finish the current task and stop using tools.</system-reminder>`,
          turnId,
          createdAt: new Date().toISOString(),
        })
      }

      const assistantMessage: ChatMessage & { type: 'message' } = {
        type: 'message',
        id: randomUUID(),
        role: 'assistant',
        content: response.content,
        turnId,
        createdAt: new Date().toISOString(),
        model: this.activeModel.model,
        ...(response.reasoningContent ? { reasoningContent: response.reasoningContent } : {}),
        ...(response.thinkingBlocks && response.thinkingBlocks.length > 0
          ? { thinkingBlocks: response.thinkingBlocks }
          : {}),
      }
      await this.appendRecord(assistantMessage)
      this.options.onRecord?.(assistantMessage)

      if (response.toolCalls.length === 0) {
        const finished = await this.finishTurn({
          content: response.content,
          usage,
          turnId,
          turnStartedAt,
          turnResponseUsage,
          turnToolCalls,
          signal,
        })
        if (finished.continueLoop) continue
        return finished.result
      }

      // Check abort signal before executing tools
      if (signal?.aborted) {
        throw new DOMException('The operation was aborted.', 'AbortError')
      }

      const toolResults = await this.runToolCallsInOrder(response.toolCalls, signal, turnId)

      if (toolResults.length > 0 && toolResults.every((r) => !r.ok)) {
        await this.appendRecord({
          type: 'message',
          id: randomUUID(),
          role: 'user',
          content: '<system-reminder>All tool calls in the previous turn failed. Review the errors above and decide how to proceed — try a different approach, ask the user for help, or report the failures.</system-reminder>',
          turnId,
          createdAt: new Date().toISOString(),
        })
      }
    }

    throw new Error('Agent loop exceeded maximum tool iterations')
  }

  private async loadPreparedRecords(): Promise<SessionRecord[]> {
    const loaded = await this.loadRecordsOnce()
    const prepared = prepareRecordsForRequestWithDiagnostics(
      loaded.records,
      this.options.contextManagement,
      new Date(),
      {
        repairToolPairing: !this.recordsCacheHasCleanToolProtocol,
        ...(this.stripAllThinkingBlocksFromRequests ? { recentAssistantThinkingTurnsToKeep: 0 } : {}),
      },
    )
    if (!prepared.diagnostics.some((diagnostic) => diagnostic.code === 'tool_protocol_repaired')) {
      this.recordsCacheHasCleanToolProtocol = true
    }
    logDiagnostics([...loaded.diagnostics, ...prepared.diagnostics])
    return prepared.records
  }

  private async loadRecordsOnce(): Promise<{ records: SessionRecord[]; diagnostics: RuntimeDiagnostic[] }> {
    if (this.recordsCache) {
      return { records: this.recordsCache, diagnostics: [] }
    }

    const loaded = this.options.recordStream.loadWithDiagnostics
      ? await this.options.recordStream.loadWithDiagnostics()
      : { records: await this.options.recordStream.load(), diagnostics: [] }
    this.recordsCache = [...loaded.records]
    this.recordsCacheHasCleanToolProtocol = false
    return { records: this.recordsCache, diagnostics: loaded.diagnostics }
  }

  private async appendRecord(record: SessionRecord): Promise<void> {
    await this.options.recordStream.append(record)
    this.noteRecordAppended(record)
  }

  private pendingPostCompactRestoreRecordIds(records: SessionRecord[]): string[] {
    const loadedRecords = this.recordsCache ?? records
    return loadedRecords
      .filter((record) => record.type === 'compact_boundary' && record.postCompactRestore === 'pending')
      .map((record) => record.id)
  }

  private async consumePostCompactRestoreRecords(recordIds: string[]): Promise<void> {
    for (const recordId of recordIds) {
      await this.options.recordStream.update?.(recordId, (record) => {
        if (record.type !== 'compact_boundary' || record.postCompactRestore !== 'pending') return record
        return { ...record, postCompactRestore: 'consumed' }
      })
      this.recordsCache = this.recordsCache?.map((record) => {
        if (record.id !== recordId || record.type !== 'compact_boundary' || record.postCompactRestore !== 'pending') {
          return record
        }
        return { ...record, postCompactRestore: 'consumed' }
      })
    }
  }

  private async runToolCallsInOrder(calls: ToolCall[], signal?: AbortSignal, turnId?: string): Promise<ToolResultRecord[]> {
    const results: ToolResultRecord[] = []
    let index = 0

    while (index < calls.length) {
      if (signal?.aborted) {
        throw new DOMException('The operation was aborted.', 'AbortError')
      }

      const call = calls[index]
      if (!call) break

      if (!this.isConcurrencySafe(call)) {
        const result = await this.options.toolRunner.run(call, this.options.toolContext, signal, turnId)
        results.push(result)
        if (result.errorCode === 'aborted' || signal?.aborted) {
          throw new DOMException('The operation was aborted.', 'AbortError')
        }
        index += 1
        continue
      }

      const safeBatch: ToolCall[] = []
      while (index < calls.length) {
        const candidate = calls[index]
        if (!candidate || !this.isConcurrencySafe(candidate)) break
        safeBatch.push(candidate)
        index += 1
      }

      const settled = await Promise.allSettled(
        safeBatch.map((toolCall) => this.options.toolRunner.run(toolCall, this.options.toolContext, signal, turnId)),
      )
      let firstRejection: unknown
      let sawAbort = false
      for (const item of settled) {
        if (item.status === 'fulfilled') {
          results.push(item.value)
          if (item.value.errorCode === 'aborted') {
            sawAbort = true
          }
        } else {
          firstRejection ??= item.reason
          if (isAbortError(item.reason)) {
            sawAbort = true
          }
        }
      }

      if (sawAbort || signal?.aborted) {
        throw new DOMException('The operation was aborted.', 'AbortError')
      }
      if (firstRejection !== undefined) {
        throw firstRejection
      }
    }

    return results
  }

  private isConcurrencySafe(call: ToolCall): boolean {
    return this.options.tools.find((tool) => tool.name === call.name)?.isConcurrencySafe === true
  }

  private async emitTurnMetric(startedAt: number, usage: TokenUsage, toolCalls: number): Promise<void> {
    await this.emitMetric({
      event: 'turn',
      model: this.activeModel.model,
      input_tokens: usage.inputTokens,
      response_tokens: usage.outputTokens,
      cache_read_tokens: usage.cacheReadInputTokens,
      cache_hit_rate: cacheHitRate(usage.inputTokens, usage.cacheReadInputTokens),
      tool_calls: toolCalls,
      duration_ms: Date.now() - startedAt,
    })
  }

  private async runUserPromptSubmitHooks(userInput: string, turnId: string, signal?: AbortSignal): Promise<void> {
    const result = await runLifecycleHooks(
      this.options.hooks?.userPromptSubmit,
      'userPromptSubmit',
      { prompt: userInput },
      this.options.toolContext,
      signal,
    )
    await this.appendLifecycleHookMessages('userPromptSubmit', result.stdout, result.failures, turnId)
  }

  private async finishTurn(input: {
    content: string
    usage: TokenUsage
    turnId: string
    turnStartedAt: number
    turnResponseUsage: TokenUsage
    turnToolCalls: number
    signal?: AbortSignal
  }): Promise<{ continueLoop: true } | { continueLoop: false; result: AgentRunResult }> {
    const result = await runLifecycleHooks(
      this.options.hooks?.stop,
      'stop',
      {
        response: input.content,
        model: this.activeModel.model,
        modelKey: this.activeModel.modelKey,
      },
      this.options.toolContext,
      input.signal,
    )
    await this.appendLifecycleHookMessages('stop', result.stdout, result.failures, input.turnId)
    if (result.preventContinuation) {
      await this.emitTurnMetric(input.turnStartedAt, input.turnResponseUsage, input.turnToolCalls)
      return { continueLoop: false, result: { content: input.content, usage: input.usage } }
    }
    if (result.blockingErrors.length > 0) {
      await this.appendRecord({
        type: 'message',
        id: randomUUID(),
        role: 'user',
        content: `<system-reminder>stop hook blocking error:\n${result.blockingErrors.join('\n')}</system-reminder>`,
        turnId: input.turnId,
        createdAt: new Date().toISOString(),
      })
      return { continueLoop: true }
    }
    await this.emitTurnMetric(input.turnStartedAt, input.turnResponseUsage, input.turnToolCalls)
    return { continueLoop: false, result: { content: input.content, usage: input.usage } }
  }

  private async appendLifecycleHookMessages(
    hookName: 'userPromptSubmit' | 'stop',
    stdout: string,
    failures: string[],
    turnId: string,
  ): Promise<void> {
    const blocks: string[] = []
    if (stdout.trim()) {
      blocks.push(stdout.trim())
    }
    if (failures.length > 0) {
      blocks.push(`Hook failures:\n${failures.join('\n')}`)
    }
    if (blocks.length === 0) return

    await this.appendRecord({
      type: 'message',
      id: randomUUID(),
      role: 'user',
      content: `<system-reminder>${hookName} hook output:\n${blocks.join('\n\n')}</system-reminder>`,
      turnId,
      createdAt: new Date().toISOString(),
    })
  }

  private async emitMetric(metric: SessionMetricInput): Promise<void> {
    try {
      await this.options.recordStream.appendMetric?.(metric)
    } catch {
      // Metrics are best-effort and must not affect the user turn.
    }
  }

  private get activeModel(): ActiveModelRuntime {
    return this.modelState.current
  }

  private activateFallback(cacheSource: ReturnType<typeof agentCacheSource>): boolean {
    const fallback = this.modelState.fallback
    if (!fallback) return false
    if (this.isSameModel(fallback, this.activeModel)) return false

    this.switchActiveModel(fallback, cacheSource)
    this.modelState.fallbackActivatedAt = Date.now()
    return true
  }

  private retryPrimaryIfReady(cacheSource: ReturnType<typeof agentCacheSource>): boolean {
    if (!this.modelState.fallback) return false
    if (!this.isSameModel(this.activeModel, this.modelState.fallback)) return false
    if (this.isSameModel(this.modelState.primary, this.modelState.fallback)) return false

    const fallbackActivatedAt = this.modelState.fallbackActivatedAt
    if (fallbackActivatedAt === undefined) return false

    const retryDelayMs = this.options.fallbackRetryDelayMs ?? DEFAULT_FALLBACK_RETRY_DELAY_MS
    if (Date.now() - fallbackActivatedAt < retryDelayMs) return false

    this.switchActiveModel(this.modelState.primary, cacheSource)
    this.modelState.fallbackActivatedAt = undefined
    return true
  }

  private switchActiveModel(next: ActiveModelRuntime, cacheSource: ReturnType<typeof agentCacheSource>): void {
    this.modelState.current = next
    this.stripAllThinkingBlocksFromRequests = true
    resetCacheBreakDetection(cacheSource)
    this.options.contextBuilder.clearCachedSections()
  }

  private isSameModel(a: ActiveModelRuntime, b: ActiveModelRuntime): boolean {
    if (a.modelKey || b.modelKey) return a.modelKey === b.modelKey
    return a.provider === b.provider && a.model === b.model
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}
