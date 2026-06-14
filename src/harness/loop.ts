import { randomUUID } from 'node:crypto'
import os from 'node:os'
import { ContextBuilder } from './contextBuilder.js'
import { isToolSearchEnabled, extractDiscoveredToolNames, filterToolsForRequest } from '../utils/toolSearch.js'
import type { EnvironmentInfo } from './contextBuilder.js'
import { ToolRunner } from './toolRunner.js'
import { EMPTY_TOKEN_USAGE, addTokenUsage } from './usage.js'
import { autoCompactIfNeeded, summarizeRecordsForContinuation } from './compact.js'
import {
  prepareRecordsForRequestWithDiagnostics,
  requestTokenCountFromUsage,
} from './requestPrep.js'
import { applyProgressiveCompaction } from './progressiveCompact.js'
import { summarizeToolUse } from './toolUseSummary.js'
import { agentCacheSource, formatCacheHitRate, notifyCompaction, resetCacheBreakDetection, type CacheBreakSource } from './cacheBreakDetection.js'
import { logDiagnostics, type RuntimeDiagnostic } from './diagnostics.js'
import { cacheHitRate, type SessionMetricInput } from './metrics.js'
import type { RecordStream } from './recordStream.js'
import { MemoryRecordStream } from './recordStream.js'
import { runLifecycleHooks, type Hooks, type LifecycleHookName } from './hooks.js'
import { FallbackTriggeredError } from '../config/retry.js'
import type { ContextManagementConfig } from '../prompts/budget.js'
import type { SkillDefinition } from '../services/skills/skillsService.js'
import type { CacheRuntime } from './cacheControl.js'
import type { PermissionMode } from './permissions.js'
import type { PlanModeManager } from './planModeManager.js'
import type { AgentRunResult, ChatMessage, ModelProvider, ModelStreamEvent, SessionRecord, Tool, ToolCall, ToolContext, ToolResultRecord, ToolUseSummaryRecord, TokenUsage } from './types.js'
import type { ThinkingConfig } from '../config/service.js'
import { remainingTasksFromState } from '../tools/taskFormat.js'
import { ENTER_PLAN_MODE_TOOL_NAME, EXIT_PLAN_MODE_TOOL_NAME } from '../tools/toolNames.js'
import { buildAtMentionContextRecord } from './atMentions.js'
import { wrapInSystemReminder } from './systemReminder.js'

export interface ActiveModelRuntime {
  provider: ModelProvider
  model: string
  modelKey?: string
  providerName?: string
  promptCacheRetention?: 'in_memory' | '24h'
}

/**
 * Options for {@link AgentLoop.runTool}. All fields are optional; by default
 * the call is isolated (records routed to a fresh in-memory stream, toolContext
 * forked from the main loop). Provide explicit overrides to opt into
 * participation with the main session.
 */
export interface RunToolOptions {
  /** Aborts the dispatched tool call. Does not abort a pending run() ahead of it in the queue. */
  signal?: AbortSignal
  /** Override the toolContext. Defaults to a forked copy of the loop's main toolContext. */
  toolContext?: ToolContext
  /** Override the record stream. Defaults to an isolated in-memory stream. */
  recordStream?: RecordStream
  /** Override the turnId stamped on emitted records. Defaults to a fresh UUID. */
  turnId?: string
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
  criticalSystemReminder?: string
  skills?: SkillDefinition[]
  promptCacheRetention?: 'in_memory' | '24h'
  contextManagement?: Partial<ContextManagementConfig>
  isGitRepo?: boolean
  maxTurns?: number
  maxTurnsExceededBehavior?: 'error' | 'partial'
  maxOutputTokens?: number
  tokenBudget?: number
  tokenWarningThreshold?: number
  thinking?: { type: 'adaptive' } | { type: 'enabled'; budgetTokens: number } | { type: 'disabled' }
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  fallbackModel?: ActiveModelRuntime
  compactModel?: ActiveModelRuntime
  planModel?: ActiveModelRuntime
  fallbackRetryDelayMs?: number
  hooks?: Hooks
  cacheRuntime?: CacheRuntime
  cacheSource?: CacheBreakSource
  preloadRecords?: SessionRecord[]
  permissionMode?(): PermissionMode
  planModeManager?: PlanModeManager
  getCompactFailureCount?(): Promise<number>
  setCompactFailureCount?(count: number): Promise<void>
  recordStream: RecordStream
  onRecord?(record: SessionRecord): void
  onStreamEvent?(event: ModelStreamEvent): void
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
  private pendingSubagentTranscriptUsage: TokenUsage = { ...EMPTY_TOKEN_USAGE }
  private readonly pendingToolUseSummaries: PendingToolUseSummary[] = []
  // Serializes run() and runTool() against each other. Both helpers funnel
  // through enqueue() so that a tool dispatched via runTool cannot race a
  // concurrent run() and clobber shared state in the toolContext,
  // recordsCache, or recordStream.
  private inFlight: Promise<unknown> | null = null
  // Sticky for the rest of the session after any model switch: thinking
  // signatures are model/provider-bound, and prior primary/fallback thinking
  // blocks should not be replayed across either side of a fallback boundary.
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
    this.options.toolContext.appendMetric = (metric) => this.emitMetric(metric)
    this.options.toolRunner.addRecordListener((record) => {
      this.noteRecordAppended(record)
    })
  }

  getActiveModel(): Omit<ActiveModelRuntime, 'provider'> {
    const visibleModel = this.isPlanModelActive() ? this.modelState.primary : this.activeModel
    return {
      model: visibleModel.model,
      modelKey: visibleModel.modelKey,
      providerName: visibleModel.providerName,
      promptCacheRetention: visibleModel.promptCacheRetention,
    }
  }

  clearCachedSections(key?: string): void {
    this.options.contextBuilder.clearCachedSections(key)
  }

  invalidateAvailableToolsSection(): void {
    this.options.contextBuilder.invalidateAvailableToolsSection()
  }

  invalidateSkillsSection(): void {
    this.options.contextBuilder.invalidateSkillsSection()
  }

  invalidateRecordsCache(): void {
    this.recordsCache = undefined
    this.recordsCacheHasCleanToolProtocol = false
  }

  /** Update thinking config at runtime; takes effect on the next turn. */
  setThinking(thinking: ThinkingConfig | undefined): void {
    this.options.thinking = thinking
  }

  getThinking(): ThinkingConfig | undefined {
    return this.options.thinking
  }

  /** Update effort level at runtime; takes effect on the next turn. */
  setEffort(effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | undefined): void {
    this.options.effort = effort
  }

  getEffort(): 'low' | 'medium' | 'high' | 'xhigh' | 'max' | undefined {
    return this.options.effort
  }

  noteRecordAppended(record: SessionRecord): void {
    this.recordsCache?.push(record)
    if (record.type === 'subagent_transcript') {
      this.pendingSubagentTranscriptUsage = addTokenUsage(this.pendingSubagentTranscriptUsage, record.usage)
    }
    if (record.type === 'tool_use' || record.type === 'tool_result') {
      this.recordsCacheHasCleanToolProtocol = false
    }
  }

  async run(userInput: string, signal?: AbortSignal, messageId?: string): Promise<AgentRunResult> {
    return this.enqueue(() => this.runInternal(userInput, signal, messageId))
  }

  async summarizeRecordsForRewind(records: SessionRecord[]): Promise<{ summary: string; usage?: TokenUsage; preTokens: number }> {
    return this.enqueue(async () => {
      const result = await summarizeRecordsForContinuation({
        records,
        provider: this.activeModel.provider,
        model: this.activeModel.model,
        compactRuntime: this.options.compactModel,
        promptCacheRetention: this.activeModel.promptCacheRetention,
      })
      return {
        summary: result.content,
        usage: result.usage,
        preTokens: result.preTokens,
      }
    })
  }

  private async runInternal(userInput: string, signal?: AbortSignal, messageId?: string): Promise<AgentRunResult> {
    let usage = { ...EMPTY_TOKEN_USAGE }
    let pendingAssistantStreamContent = ''
    this.pendingSubagentTranscriptUsage = { ...EMPTY_TOKEN_USAGE }
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
    if (!userInput.trimStart().startsWith('/')) {
      const atMentionRecord = await buildAtMentionContextRecord({
        userInput,
        userMessageId: userMessage.id,
        turnId,
        toolContext: this.options.toolContext,
        createdAt: new Date().toISOString(),
      })
      if (atMentionRecord) {
        await this.appendRecord(atMentionRecord)
      }
    }
    try {
      await this.runUserPromptSubmitHooks(userInput, turnId, signal)
      let lastResponseTokenCount: number | undefined
      let lastResponseRecordCount: number | undefined
      let lastResponseRecordId: string | undefined

      const maxTurns = this.options.maxTurns ?? 100
      const tokenBudget = this.options.tokenBudget
      const tokenWarnThreshold = this.options.tokenWarningThreshold ?? 0.8
      const cacheSource = this.options.cacheSource ?? agentCacheSource(this.options.toolContext.sessionId)

      let lastRequestId: string | undefined
      let maxOutputTokensOverride: number | undefined = this.options.maxOutputTokens
      let maxOutputTokensRecoveryCount = 0
      const responseSegments: string[] = []
      let lastAssistantContent = ''
      const resetModelRequestState = () => {
        lastRequestId = undefined
        maxOutputTokensOverride = this.options.maxOutputTokens
        maxOutputTokensRecoveryCount = 0
      }

      for (let iteration = 0; iteration < maxTurns; iteration++) {
        // Check abort signal at the start of each iteration
        if (signal?.aborted) {
          throw new DOMException('The operation was aborted.', 'AbortError')
        }
        await this.options.planModeManager?.beforeTurn()
        if (this.options.planModeManager?.consumeShouldStopCurrentTurn()) {
          return { content: '', usage }
        }
        if (this.syncRoleModel(cacheSource)) {
          resetModelRequestState()
        }
        await this.flushReadyToolUseSummaries(turnId)
        const preparedRecords = await this.loadPreparedRecords()
        const interruptionContext = await this.consumeTurnInterruptionContext(preparedRecords, userInput)
        const progressive = applyProgressiveCompaction({
        records: preparedRecords,
        system: this.options.system,
        contextManagement: this.options.contextManagement,
        lastResponseTokenCount,
        lastResponseRecordCount,
        lastResponseRecordId,
      })
      let recordsBeforeCompact = progressive.records
      const useCachedTokenEstimate = !progressive.microCompacted && !progressive.snipped
      const compactResult = await autoCompactIfNeeded({
        records: recordsBeforeCompact,
        provider: this.activeModel.provider,
        model: this.activeModel.model,
        compactRuntime: this.options.compactModel,
        tools: this.options.tools,
        system: this.options.system,
        contextManagement: this.options.contextManagement,
        lastResponseTokenCount: useCachedTokenEstimate ? lastResponseTokenCount : undefined,
        lastResponseRecordCount: useCachedTokenEstimate ? lastResponseRecordCount : undefined,
        lastResponseRecordId: useCachedTokenEstimate ? lastResponseRecordId : undefined,
        discoveredToolNames: this.options.toolContext.discoveredToolNames,
        promptCacheRetention: this.activeModel.promptCacheRetention,
        turnId,
        circuitKey: this.options.toolContext.sessionId,
        getCompactFailureCount: this.options.getCompactFailureCount,
        setCompactFailureCount: this.options.setCompactFailureCount,
        appendRecord: (record) => this.appendRecord(record),
        onBeforeCompact: (event) => this.runCompactHooks('preCompact', event, turnId, signal),
        onAfterCompact: (event) => this.runCompactHooks('postCompact', event, turnId, signal),
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
        resetModelRequestState()
        if (this.syncRoleModel(cacheSource)) {
          resetModelRequestState()
        }
        recordsBeforeCompact = await this.loadPreparedRecords()
      }

      const records = recordsBeforeCompact
      const pendingRestoreRecordIds = this.pendingPostCompactRestoreRecordIds(records)
      const planAttachment = this.options.planModeManager?.getActivePlanAttachment()
      const env: EnvironmentInfo = {
        cwd: this.options.toolContext.cwd,
        platform: process.platform,
        shell: process.env.SHELL ?? (process.platform === 'win32' ? 'powershell' : 'bash'),
        osVersion: `${os.type()} ${os.release()}`,
        isGitRepo: this.options.isGitRepo ?? false,
        model: this.activeModel.model,
      }

        const built = await this.options.contextBuilder.build({
        preloadRecords: this.options.preloadRecords,
        records,
        tools: this.options.tools,
        system: this.options.system,
        projectContext: this.options.projectContext,
        criticalSystemReminder: this.options.criticalSystemReminder,
        skills: this.options.skills,
        toolContext: this.options.toolContext,
        env,
        permissionMode: this.options.permissionMode?.(),
        transientUserContext: [planAttachment, interruptionContext].filter((item): item is string => Boolean(item)),
        includePostCompactRestore: pendingRestoreRecordIds.length > 0,
      })
      await this.consumePostCompactRestoreRecords(pendingRestoreRecordIds)

      const requestRecordCount = records.length
      const canReuseResponseTokenEstimate = useCachedTokenEstimate && !compactResult.compacted
      pendingAssistantStreamContent = ''

      // Set provider name on tool context for ToolSearchTool dual-provider support
      this.options.toolContext.providerName = this.activeModel.providerName
      // Inject full tool list for ToolSearchTool scoring
      this.options.toolContext._allTools = this.options.tools

      const hasDeferred = isToolSearchEnabled() && this.options.tools.some(t => t.shouldDefer || t.isMcp)

      // Compute deferred tool names from the FULL (unfiltered) tool list.
      // This is used by the payload builder for <available-deferred-tools>,
      // NOT for the API tools array (which uses filteredTools).
      const allDeferredToolNames = hasDeferred
        ? new Set(this.options.tools.filter(t => t.shouldDefer || t.isMcp).map(t => t.name))
        : undefined

      // Filter tools: only include deferred tools that have been discovered
      // via tool_reference blocks in message history. Non-deferred tools and
      // ToolSearch itself are always included.
      const discoveredNames = extractDiscoveredToolNames(records)

      // Separate pre-compact vs post-compact discovered tools.
      // After compaction, tool_reference blocks from pre-compact messages are lost.
      // Tools discovered before compaction should NOT have defer_loading — their
      // schema was already loaded and the tool_reference is no longer in history.
      const preCompactDiscoveredNames = new Set<string>()
      for (const record of records) {
        if (record.type === 'compact_boundary' && record.preCompactDiscoveredTools) {
          for (const name of record.preCompactDiscoveredTools) preCompactDiscoveredNames.add(name)
        }
      }
      // Post-compact discovered = all discovered minus pre-compact
      const postCompactDiscoveredNames = new Set<string>()
      for (const name of discoveredNames) {
        if (!preCompactDiscoveredNames.has(name)) postCompactDiscoveredNames.add(name)
      }
      // Store for the payload builder to use as defer_loading candidates
      this.options.toolContext._postCompactDiscoveredNames = postCompactDiscoveredNames
      // Sync back to toolContext for post-compact restore
      if (discoveredNames.size > 0) {
        this.options.toolContext.discoveredToolNames ??= new Set()
        for (const name of discoveredNames) {
          this.options.toolContext.discoveredToolNames.add(name)
        }
      }
      const filteredTools = hasDeferred
        ? filterToolsForRequest(this.options.tools, discoveredNames)
        : this.options.tools

      const modelRequest = {
        system: built.system,
        systemBlocks: built.systemBlocks,
        messages: built.messages,
        contextItems: built.contextItems,
        tools: filteredTools,
        model: this.activeModel.model,
        promptCacheRetention: this.activeModel.promptCacheRetention,
        maxOutputTokens: maxOutputTokensOverride,
        thinking: this.options.thinking,
        effort: this.options.effort,
        previousRequestId: lastRequestId,
        retry: { signal },
        cacheSource,
        cacheRuntime: this.options.cacheRuntime,
        hasDeferredTools: hasDeferred,
        allDeferredToolNames,
        postCompactDiscoveredNames: this.options.toolContext._postCompactDiscoveredNames,
        onTextDelta: (delta: string) => {
          pendingAssistantStreamContent += delta
        },
        onStreamEvent: (event: ModelStreamEvent) => {
          this.options.onStreamEvent?.(event)
        },
      }

      let response
      const modelStartedAt = Date.now()
      try {
        response = await this.activeModel.provider.createMessage(modelRequest)
        pendingAssistantStreamContent = ''
      } catch (error) {
        if (error instanceof FallbackTriggeredError && this.activateFallback(cacheSource)) {
          pendingAssistantStreamContent = ''
          resetModelRequestState()
          continue
        }
        throw error
      }

      usage = addTokenUsage(usage, response.usage)
      await this.emitTurnMetric(modelStartedAt, response.usage ?? EMPTY_TOKEN_USAGE, response.toolCalls.length)
      lastResponseTokenCount = canReuseResponseTokenEstimate
        ? requestTokenCountFromUsage(response.usage)
        : undefined
      lastResponseRecordCount = lastResponseTokenCount === undefined ? undefined : requestRecordCount
      lastResponseRecordId = lastResponseTokenCount === undefined ? undefined : records.at(-1)?.id
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

      // max_output_tokens escalation: retry with higher limit
      if (response.stopReason === 'max_tokens') {
        if (maxOutputTokensOverride === undefined) {
          maxOutputTokensOverride = ESCALATED_MAX_TOKENS
          continue
        }

        await this.appendRecord(assistantMessage)
        const maxTokensContent = appendResponseSegment(responseSegments, response.content)
        if (maxOutputTokensRecoveryCount < MAX_RECOVERY_COUNT) {
          await this.appendRecord({
            type: 'message',
            id: randomUUID(),
            role: 'user',
            content: buildMaxTokensContinuationReminder(this.options.toolContext.taskState),
            turnId,
            createdAt: new Date().toISOString(),
          })
          maxOutputTokensRecoveryCount++
          continue
        }

        const finished = await this.finishTurn({
          content: maxTokensContent,
          usage,
          turnId,
          signal,
          stopReason: 'max_tokens',
          truncated: true,
          segments: [...responseSegments],
        })
        if (finished.continueLoop) continue
        return finished.result
      }

      const responseContent = combineResponseSegments(responseSegments, response.content)
      lastAssistantContent = responseContent

      // Token budget check
      const cumulativeTokens = requestTokenCountFromUsage(usage) ?? 0
      if (tokenBudget && cumulativeTokens > tokenBudget) {
        const finished = await this.finishTurn({
          content: `${responseContent}\n\n[Token budget exceeded: ${cumulativeTokens} > ${tokenBudget}]`,
          usage,
          turnId,
          signal,
          segments: segmentsWithFinalResponse(responseSegments, response.content),
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
          content: wrapInSystemReminder(`Token budget at ${pct}%. Finish the current task and stop using tools.`),
          turnId,
          createdAt: new Date().toISOString(),
        })
      }

      if (response.toolCalls.length === 0) {
        if (this.options.permissionMode?.() === 'plan') {
          const content = responseContent.trim()
          if (content.length > 0 && this.options.planModeManager) {
            await this.options.planModeManager.submitAssistantPlanFallback(responseContent, turnId)
          } else {
            await this.appendRecord({
              type: 'message',
              id: randomUUID(),
              role: 'user',
              content: wrapInSystemReminder('Plan mode is active. Do not end your turn with ordinary assistant text. Use AskUserQuestion for unresolved decisions, or call ExitPlanMode when the plan is ready for approval.'),
              turnId,
              createdAt: new Date().toISOString(),
            })
          }
          continue
        }

        await this.appendRecord(assistantMessage)
        const finished = await this.finishTurn({
          content: responseContent,
          usage,
          turnId,
          signal,
          segments: segmentsWithFinalResponse(responseSegments, response.content),
        })
        if (finished.continueLoop) continue
        return finished.result
      }

      await this.appendRecord(assistantMessage)

      // Check abort signal before executing tools
      if (signal?.aborted) {
        throw new DOMException('The operation was aborted.', 'AbortError')
      }

      const toolResults = await this.runToolCallsInOrder(response.toolCalls, signal, turnId)
      this.options.planModeManager?.noteToolUseTurn()
      usage = addTokenUsage(usage, this.drainSubagentTranscriptUsage())
      this.startToolUseSummary(toolResults, turnId)

      // Track discovered tool names from ToolSearch results
      this.trackDiscoveredTools(toolResults)

      if (toolResults.length > 0 && toolResults.every((r) => !r.ok)) {
        await this.appendRecord({
          type: 'message',
          id: randomUUID(),
          role: 'user',
          content: wrapInSystemReminder('All tool calls in the previous turn failed. Review the errors above and decide how to proceed — try a different approach, ask the user for help, or report the failures.'),
          turnId,
          createdAt: new Date().toISOString(),
        })
      }
      }

      if (this.options.maxTurnsExceededBehavior === 'partial') {
        const content = buildMaxTurnsExceededContent(lastAssistantContent, maxTurns)
        const finished = await this.finishTurn({
          content,
          usage,
          turnId,
          signal,
          stopReason: 'max_turns',
          truncated: true,
          segments: content ? [content] : undefined,
        })
        if (!finished.continueLoop) return finished.result
        return finishResult({
          content,
          usage,
          stopReason: 'max_turns',
          truncated: true,
          segments: content ? [content] : undefined,
        })
      }

      throw new Error('Agent loop exceeded maximum tool iterations')
    } catch (error) {
      if (isAbortError(error) && isUserCancelAbort(signal)) {
        await this.appendPartialAssistantMessage(pendingAssistantStreamContent, turnId)
        pendingAssistantStreamContent = ''
        await this.appendTurnInterruption(userMessage, turnId)
      }
      throw error
    }
  }

  private async consumeTurnInterruptionContext(records: readonly SessionRecord[], userInput: string): Promise<string | undefined> {
    const interruption = [...records]
      .reverse()
      .find((record) => record.type === 'turn_interruption' && record.recoverable && !record.consumedAt)
    if (!interruption || interruption.type !== 'turn_interruption') return undefined

    const intent = classifyInterruptionIntent(userInput)
    await this.consumeTurnInterruption(interruption.id)

    const remaining = interruption.remainingTasks.length > 0
      ? interruption.remainingTasks.map((task) => `- #${task.id} [${task.status}] ${task.subject}`).join('\n')
      : '- No tracked remaining tasks.'

    if (intent === 'continue') {
      return wrapInSystemReminder([
        'The previous turn was interrupted by the user and is now being resumed. Continue from where you left off, but do not blindly repeat tool calls that already completed.',
        `Interrupted prompt:\n${interruption.prompt}`,
        `Remaining tracked tasks:\n${remaining}`,
        'Before doing more work, inspect or update TaskList so task status reflects the resumed state.',
      ].join('\n'))
    }

    if (intent === 'abandon') {
      return wrapInSystemReminder([
        'The previous interrupted turn has been abandoned by the user. Do not resume or replay it unless the user asks again.',
        `Previously remaining tracked tasks:\n${remaining}`,
      ].join('\n'))
    }

    return wrapInSystemReminder([
      'There is an interrupted prior turn, but the user has provided a new request. Do not automatically replay the interrupted prompt.',
      `Interrupted prompt:\n${interruption.prompt}`,
      `Previously remaining tracked tasks:\n${remaining}`,
      'Treat those tasks as context only; follow the latest user request.',
    ].join('\n'))
  }

  private async consumeTurnInterruption(recordId: string): Promise<void> {
    try {
      await this.options.recordStream.update?.(recordId, (record) => {
        if (record.type !== 'turn_interruption') return record
        return {
          ...record,
          recoverable: false,
          consumedAt: new Date().toISOString(),
        }
      })
      this.recordsCache = this.recordsCache?.map((record) => {
        if (record.type !== 'turn_interruption' || record.id !== recordId) return record
        return {
          ...record,
          recoverable: false,
          consumedAt: new Date().toISOString(),
        }
      })
    } catch (error) {
      if (process.env.MYAGENT_DEBUG_PROVIDER === '1') {
        console.error(`[hanekawa][interrupt] failed to consume interruption ${recordId}:`, error)
      }
    }
  }

  private async appendTurnInterruption(userMessage: ChatMessage & { type: 'message' }, turnId: string): Promise<void> {
    if (this.recordsCache?.some((record) => record.type === 'turn_interruption' && record.turnId === turnId)) return
    await this.appendRecord({
      id: randomUUID(),
      type: 'turn_interruption',
      turnId,
      userMessageId: userMessage.id,
      prompt: userMessage.content,
      remainingTasks: remainingTasksFromState(this.options.toolContext.taskState),
      recoverable: true,
      createdAt: new Date().toISOString(),
    })
  }

  private async appendPartialAssistantMessage(content: string, turnId: string): Promise<void> {
    if (content.trim().length === 0) return
    await this.appendRecord({
      type: 'message',
      id: randomUUID(),
      role: 'assistant',
      content,
      turnId,
      createdAt: new Date().toISOString(),
      model: this.activeModel.model,
    })
  }

  /**
   * Run a single tool call out-of-band. By default the call is fully isolated
   * from the main loop: it gets its own in-memory record stream (so tool_use,
   * tool_approval, and tool_result records do not pollute the main session's
   * persisted JSONL or the records cache), and a forked toolContext (so
   * mutable state — readFiles, readFileState, invokedSkills, taskState — is
   * not shared with the main loop's pending or future run()).
   *
   * Calls are serialized against run() and other runTool() invocations via
   * the loop's in-flight gate. If a concurrent run() is in progress, this
   * call waits for it to finish before executing.
   *
   * Use this for diagnostic dispatch that should leave no trace in the main
   * conversation. Pass `recordStream` and/or `toolContext`
   * explicitly only if you actually want the call to participate in the main
   * session — e.g. tests asserting record persistence.
   */
  async runTool(call: ToolCall, options?: RunToolOptions): Promise<ToolResultRecord> {
    if (options?.signal?.aborted) {
      throw new DOMException('The operation was aborted.', 'AbortError')
    }
    return this.enqueue(() => this.runToolInternal(call, options))
  }

  private async runToolInternal(call: ToolCall, options?: RunToolOptions): Promise<ToolResultRecord> {
    if (options?.signal?.aborted) {
      throw new DOMException('The operation was aborted.', 'AbortError')
    }

    const recordStream: RecordStream = options?.recordStream ?? new MemoryRecordStream()
    const toolContext = options?.toolContext ?? this.forkToolContext()
    const turnId = options?.turnId ?? randomUUID()

    const isolatedRunner = this.options.toolRunner.fork({
      onRecord: async (record) => {
        await recordStream.append(record)
      },
    })

    return isolatedRunner.run(call, toolContext, options?.signal, turnId)
  }

  /**
   * Produce a shallow-but-collection-cloned copy of the configured
   * toolContext. Sets and Maps are duplicated so mutations performed by an
   * out-of-band tool call do not leak back into the main loop's view of
   * which files have been read, what skills have been invoked, or the
   * current task list. The returned context omits transient fields
   * (abortSignal, appendRecord) which the ToolRunner installs per-call.
   */
  private forkToolContext(): ToolContext {
    const source = this.options.toolContext
    const fork: ToolContext = {
      cwd: source.cwd,
      sessionId: source.sessionId,
      readFiles: new Set(source.readFiles),
    }
    if (source.readFileState) fork.readFileState = new Map(source.readFileState)
    if (source.invokedSkills) fork.invokedSkills = new Map(source.invokedSkills)
    if (source.taskState) fork.taskState = new Map(source.taskState)
    if (source.planModeBridge) fork.planModeBridge = source.planModeBridge
    if (source.askUserQuestionBridge) fork.askUserQuestionBridge = source.askUserQuestionBridge
    return fork
  }

  /**
   * Funnel run() and runTool() through a single in-flight slot. New work
   * waits for any prior work to settle (success or failure) before starting,
   * which guarantees neither helper races on shared state. The slot is
   * cleared in finally regardless of outcome.
   */
  private async enqueue<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.inFlight
    if (previous) {
      try {
        await previous
      } catch {
        // Prior work's failure is the prior caller's concern. We only need
        // sequencing here, not error propagation.
      }
    }
    const current = (async () => work())()
    this.inFlight = current
    try {
      return await current
    } finally {
      if (this.inFlight === current) {
        this.inFlight = null
      }
    }
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
    this.options.onRecord?.(record)
  }

  private startToolUseSummary(toolResults: ToolResultRecord[], turnId: string): void {
    const runtime = this.options.compactModel
    const summarizableResults = toolResults.filter((result) => !isPlanControlTool(result.tool))
    if (!runtime || summarizableResults.length === 0) return

    const entry: PendingToolUseSummary = {
      turnId,
      status: 'pending',
      promise: summarizeToolUse({
        provider: runtime.provider,
        model: runtime.model,
        promptCacheRetention: runtime.promptCacheRetention,
        toolResults: summarizableResults,
      }),
    }
    entry.promise.then((summary) => {
      entry.status = 'ready'
      entry.record = {
        ...summary.record,
        turnId,
      }
    }).catch((error: unknown) => {
      entry.status = 'failed'
      if (process.env.MYAGENT_DEBUG_PROVIDER === '1') {
        console.error('[hanekawa][tool-summary] failed:', error)
      }
    })
    this.pendingToolUseSummaries.push(entry)
  }

  private async flushReadyToolUseSummaries(turnId: string): Promise<void> {
    if (this.pendingToolUseSummaries.length > 0) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    for (let index = 0; index < this.pendingToolUseSummaries.length;) {
      const entry = this.pendingToolUseSummaries[index]
      if (!entry || entry.status === 'pending') {
        index += 1
        continue
      }
      this.pendingToolUseSummaries.splice(index, 1)
      if (entry.status !== 'ready' || !entry.record) continue
      await this.appendRecord({
        ...entry.record,
        turnId: entry.record.turnId ?? turnId,
      })
    }
  }

  private pendingPostCompactRestoreRecordIds(records: SessionRecord[]): string[] {
    const loadedRecords = this.recordsCache ?? records
    return loadedRecords
      .filter((record) => record.type === 'compact_boundary' && record.postCompactRestore === 'pending')
      .map((record) => record.id)
  }

  private async consumePostCompactRestoreRecords(recordIds: string[]): Promise<void> {
    for (const recordId of recordIds) {
      let persisted = false
      try {
        await this.options.recordStream.update?.(recordId, (record) => {
          if (record.type !== 'compact_boundary' || record.postCompactRestore !== 'pending') return record
          return { ...record, postCompactRestore: 'consumed' }
        })
        persisted = true
      } catch (error) {
        if (process.env.MYAGENT_DEBUG_PROVIDER === '1') {
          console.error(`[hanekawa][compact] failed to persist consumed restore record ${recordId}:`, error)
        }
      }
      // Only update in-memory cache if persistence succeeded, to avoid
      // state divergence between memory and disk.
      if (persisted) {
        this.recordsCache = this.recordsCache?.map((record) => {
          if (record.id !== recordId || record.type !== 'compact_boundary' || record.postCompactRestore !== 'pending') {
            return record
          }
          return { ...record, postCompactRestore: 'consumed' }
        })
      }
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

  private drainSubagentTranscriptUsage(): TokenUsage {
    const usage = this.pendingSubagentTranscriptUsage
    this.pendingSubagentTranscriptUsage = { ...EMPTY_TOKEN_USAGE }
    return usage
  }

  /**
   * Extract discovered tool names from ToolSearch results and add them to
   * toolContext.discoveredToolNames. This set survives compaction via the
   * post-compact restore mechanism.
   */
  private trackDiscoveredTools(toolResults: ToolResultRecord[]): void {
    for (const result of toolResults) {
      if (result.tool !== 'ToolSearch' || !result.ok) continue
      // For Anthropic: content is JSON.stringify({matches, query, totalDeferredTools})
      // For OpenAI: content is plain text with schemas — skip
      try {
        const parsed = JSON.parse(result.content)
        if (Array.isArray(parsed.matches)) {
          this.options.toolContext.discoveredToolNames ??= new Set()
          for (const name of parsed.matches) {
            this.options.toolContext.discoveredToolNames.add(name)
          }
        }
      } catch {
        // Not JSON (OpenAI text format) — skip
      }
    }
  }

  private isConcurrencySafe(call: ToolCall): boolean {
    const tool = this.options.tools.find((candidate) => candidate.name === call.name)
    if (!tool || tool.isDestructive === true) return false
    if (tool.isConcurrencySafeInput) return tool.isConcurrencySafeInput(call.input)
    return tool.isConcurrencySafe === true && tool.isReadOnly === true
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

  private async runCompactHooks(
    hookName: 'preCompact' | 'postCompact',
    input: object,
    turnId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const hookInput = { ...input } as Record<string, unknown>
    const result = await runLifecycleHooks(
      this.options.hooks?.[hookName],
      hookName,
      hookInput,
      this.options.toolContext,
      signal,
      typeof hookInput.trigger === 'string' ? hookInput.trigger : undefined,
    )
    await this.appendLifecycleHookMessages(hookName, result.stdout, result.failures, turnId)
    if (result.blockingErrors.length > 0) {
      await this.appendRecord({
        type: 'message',
        id: randomUUID(),
        role: 'user',
        content: wrapInSystemReminder(`${hookName} hook blocking error:\n${result.blockingErrors.join('\n')}`),
        turnId,
        createdAt: new Date().toISOString(),
      })
    }
  }

  private async finishTurn(input: {
    content: string
    usage: TokenUsage
    turnId: string
    signal?: AbortSignal
    stopReason?: string
    truncated?: boolean
    segments?: string[]
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
      return { continueLoop: false, result: finishResult(input) }
    }
    if (result.blockingErrors.length > 0) {
      await this.appendRecord({
        type: 'message',
        id: randomUUID(),
        role: 'user',
        content: wrapInSystemReminder(`stop hook blocking error:\n${result.blockingErrors.join('\n')}`),
        turnId: input.turnId,
        createdAt: new Date().toISOString(),
      })
      return { continueLoop: true }
    }
    return { continueLoop: false, result: finishResult(input) }
  }

  private async appendLifecycleHookMessages(
    hookName: LifecycleHookName,
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
      content: wrapInSystemReminder(`${hookName} hook output:\n${blocks.join('\n\n')}`),
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

  private syncRoleModel(cacheSource: ReturnType<typeof agentCacheSource>): boolean {
    if (this.modelState.fallback && this.isSameModel(this.activeModel, this.modelState.fallback)) {
      return false
    }

    const next = this.options.permissionMode?.() === 'plan' && this.options.planModel
      ? this.options.planModel
      : this.modelState.primary

    if (this.isSameModel(this.activeModel, next)) return false
    this.switchActiveModel(next, cacheSource)
    return true
  }

  private isPlanModelActive(): boolean {
    return Boolean(this.options.planModel && this.isSameModel(this.activeModel, this.options.planModel))
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

interface PendingToolUseSummary {
  turnId: string
  status: 'pending' | 'ready' | 'failed'
  promise: Promise<{ record: ToolUseSummaryRecord; usage?: TokenUsage }>
  record?: ToolUseSummaryRecord
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

function appendResponseSegment(segments: string[], content: string): string {
  if (content.length > 0) segments.push(content)
  return combineResponseSegments(segments)
}

function combineResponseSegments(segments: readonly string[], finalContent?: string): string {
  return segmentsWithFinalResponse(segments, finalContent)?.join('\n\n') ?? ''
}

function segmentsWithFinalResponse(
  segments: readonly string[],
  finalContent?: string,
): string[] | undefined {
  const parts = [...segments]
  if (finalContent !== undefined && finalContent.length > 0) parts.push(finalContent)
  return parts.length > 0 ? parts : undefined
}

function buildMaxTokensContinuationReminder(taskState: ToolContext['taskState']): string {
  const blocks = [
    'Your previous response was cut off by the token limit. Continue from the exact point where it stopped.',
    'Do not restart, summarize, or repeat completed text. Finish the remaining answer or remaining tool-driven task directly.',
  ]
  const remaining = remainingTasksFromState(taskState)
  if (remaining.length > 0) {
    blocks.push(
      'Still-open tracked tasks:',
      ...remaining.map((task) => `- #${task.id} [${task.status}] ${task.subject}`),
    )
  }
  return wrapInSystemReminder(blocks.join('\n'))
}

function buildMaxTurnsExceededContent(content: string, maxTurns: number): string {
  const base = content.trim().length > 0
    ? content
    : '(Sub-agent reached the max turns limit before producing a final response.)'
  return `${base}\n\n[Sub-agent output may be incomplete: reached max turns limit (${maxTurns}).]`
}

function finishResult(input: {
  content: string
  usage: TokenUsage
  stopReason?: string
  truncated?: boolean
  segments?: string[]
}): AgentRunResult {
  return {
    content: input.content,
    usage: input.usage,
    ...(input.stopReason ? { stopReason: input.stopReason } : {}),
    ...(input.truncated ? { truncated: true } : {}),
    ...(input.segments && input.segments.length > 0 ? { segments: input.segments } : {}),
  }
}

function isPlanControlTool(toolName: string): boolean {
  return toolName === ENTER_PLAN_MODE_TOOL_NAME || toolName === EXIT_PLAN_MODE_TOOL_NAME
}

function classifyInterruptionIntent(input: string): 'continue' | 'abandon' | 'new_request' {
  const normalized = input.trim().toLowerCase()
  if (!normalized) return 'new_request'
  if (startsWithInterruptionCommand(normalized, [
    'continue',
    'resume',
    'carry on',
    'go on',
    'keep going',
    '继续',
    '接着',
    '恢复',
    '接着做',
    '继续做',
  ])) {
    return 'continue'
  }
  if (startsWithInterruptionCommand(normalized, [
    'cancel',
    'abort',
    'stop',
    'ignore',
    'never mind',
    'nevermind',
    '算了',
    '不用了',
    '停止',
    '放弃',
    '不要继续',
    '别继续',
  ])) {
    return 'abandon'
  }
  return 'new_request'
}

function startsWithInterruptionCommand(input: string, commands: readonly string[]): boolean {
  return commands.some((command) => {
    if (input === command) return true
    if (!input.startsWith(command)) return false
    const next = input[command.length]
    return next === undefined || /\s|[,.!?;:，。！？；：]/u.test(next)
  })
}

function isUserCancelAbort(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true && signal.reason === 'user-cancel'
}
