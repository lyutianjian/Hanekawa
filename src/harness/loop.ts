import { randomUUID } from 'node:crypto'
import os from 'node:os'
import { ContextBuilder } from './contextBuilder.js'
import type { EnvironmentInfo } from './contextBuilder.js'
import { ToolRunner } from './toolRunner.js'
import { EMPTY_TOKEN_USAGE, addTokenUsage } from './usage.js'
import { autoCompactIfNeeded } from './compact.js'
import { prepareRecordsForRequest, tokenCountFromUsage } from './requestPrep.js'
import type { ContextManagementConfig } from '../prompts/budget.js'
import type { SkillDefinition } from '../services/skills/skillsService.js'
import type { AgentRunResult, ChatMessage, ModelProvider, SessionRecord, Tool, ToolContext } from './types.js'

export interface AgentLoopOptions {
  provider: ModelProvider
  model: string
  tools: Tool[]
  contextBuilder: ContextBuilder
  toolRunner: ToolRunner
  toolContext: ToolContext
  system?: string
  skills?: SkillDefinition[]
  promptCacheRetention?: 'in_memory' | '24h'
  contextManagement?: Partial<ContextManagementConfig>
  isGitRepo?: boolean
  maxTurns?: number
  tokenBudget?: number
  tokenWarningThreshold?: number
  loadRecords(): Promise<SessionRecord[]>
  appendRecord(record: SessionRecord): Promise<void>
}

const ESCALATED_MAX_TOKENS = 64_000
const MAX_RECOVERY_COUNT = 3

export class AgentLoop {
  constructor(private readonly options: AgentLoopOptions) {}

  async run(userInput: string, signal?: AbortSignal): Promise<AgentRunResult> {
    let usage = { ...EMPTY_TOKEN_USAGE }
    const userMessage: ChatMessage & { type: 'message' } = {
      type: 'message',
      id: randomUUID(),
      role: 'user',
      content: userInput,
      createdAt: new Date().toISOString(),
    }
    await this.options.appendRecord(userMessage)
    let lastUsageTokenCount: number | undefined

    const maxTurns = this.options.maxTurns ?? 100
    const tokenBudget = this.options.tokenBudget
    const tokenWarnThreshold = this.options.tokenWarningThreshold ?? 0.8

    let lastRequestId: string | undefined
    let maxOutputTokensOverride: number | undefined
    let maxOutputTokensRecoveryCount = 0

    for (let iteration = 0; iteration < maxTurns; iteration++) {
      const recordsBeforeCompact = prepareRecordsForRequest(
        await this.options.loadRecords(),
        this.options.contextManagement,
      )
      if (iteration === 0) {
        const compactResult = await autoCompactIfNeeded({
          records: recordsBeforeCompact,
          provider: this.options.provider,
          model: this.options.model,
          tools: this.options.tools,
          system: this.options.system,
          contextManagement: this.options.contextManagement,
          lastUsageTokenCount,
          promptCacheRetention: this.options.promptCacheRetention,
          appendRecord: this.options.appendRecord,
        })
        usage = addTokenUsage(usage, compactResult.usage)
        lastUsageTokenCount = tokenCountFromUsage(usage)
      }

      const records = iteration === 0
        ? prepareRecordsForRequest(await this.options.loadRecords(), this.options.contextManagement)
        : recordsBeforeCompact
      const env: EnvironmentInfo = {
        cwd: this.options.toolContext.cwd,
        platform: process.platform,
        shell: process.env.SHELL ?? (process.platform === 'win32' ? 'powershell' : 'bash'),
        osVersion: `${os.type()} ${os.release()}`,
        isGitRepo: this.options.isGitRepo ?? false,
        model: this.options.model,
      }

      const built = this.options.contextBuilder.build({
        records,
        tools: this.options.tools,
        system: this.options.system,
        skills: this.options.skills,
        toolContext: this.options.toolContext,
        env,
      })
      const response = await this.options.provider.createMessage({
        system: built.system,
        systemBlocks: built.systemBlocks,
        messages: built.messages,
        contextItems: built.contextItems,
        tools: this.options.tools,
        model: this.options.model,
        promptCacheRetention: this.options.promptCacheRetention,
        maxOutputTokens: maxOutputTokensOverride,
        previousRequestId: lastRequestId,
        retry: { signal },
      })
      usage = addTokenUsage(usage, response.usage)
      lastUsageTokenCount = tokenCountFromUsage(usage)
      lastRequestId = response.requestId

      // max_output_tokens escalation: retry with higher limit
      if (response.stopReason === 'max_tokens') {
        if (maxOutputTokensOverride === undefined) {
          maxOutputTokensOverride = ESCALATED_MAX_TOKENS
          continue
        }

        if (maxOutputTokensRecoveryCount < MAX_RECOVERY_COUNT) {
          await this.options.appendRecord({
            type: 'message',
            id: randomUUID(),
            role: 'user',
            content: '<system-reminder>Your previous response was cut off by the token limit. Continue from where you left off.</system-reminder>',
            createdAt: new Date().toISOString(),
          })
          maxOutputTokensRecoveryCount++
          continue
        }
      }

      // Token budget check
      const cumulativeTokens = tokenCountFromUsage(usage) ?? 0
      if (tokenBudget && cumulativeTokens > tokenBudget) {
        return {
          content: `${response.content}\n\n[Token budget exceeded: ${cumulativeTokens} > ${tokenBudget}]`,
          usage,
        }
      }

      // Token warning
      if (
        tokenBudget &&
        cumulativeTokens > tokenBudget * tokenWarnThreshold &&
        response.toolCalls.length > 0
      ) {
        const pct = Math.round((cumulativeTokens / tokenBudget) * 100)
        await this.options.appendRecord({
          type: 'message',
          id: randomUUID(),
          role: 'user',
          content: `<system-reminder>Token budget at ${pct}%. Finish the current task and stop using tools.</system-reminder>`,
          createdAt: new Date().toISOString(),
        })
      }

      const assistantMessage: ChatMessage & { type: 'message' } = {
        type: 'message',
        id: randomUUID(),
        role: 'assistant',
        content: response.content,
        createdAt: new Date().toISOString(),
        model: this.options.model,
      }
      await this.options.appendRecord(assistantMessage)

      if (response.toolCalls.length === 0) {
        return { content: response.content, usage }
      }

      const toolResults: Array<{ ok: boolean }> = []
      for (const toolCall of response.toolCalls) {
        const result = await this.options.toolRunner.run(toolCall, this.options.toolContext, signal)
        toolResults.push(result)
      }

      if (toolResults.length > 0 && toolResults.every((r) => !r.ok)) {
        await this.options.appendRecord({
          type: 'message',
          id: randomUUID(),
          role: 'user',
          content: '<system-reminder>All tool calls in the previous turn failed. Review the errors above and decide how to proceed — try a different approach, ask the user for help, or report the failures.</system-reminder>',
          createdAt: new Date().toISOString(),
        })
      }
    }

    throw new Error('Agent loop exceeded maximum tool iterations')
  }
}
