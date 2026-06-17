import { randomUUID } from 'node:crypto'
import { z } from 'zod/v3'
import { agentCacheSource, forkCacheSource, resetCacheBreakDetection } from '../harness/cacheBreakDetection.js'
import { ContextBuilder } from '../harness/contextBuilder.js'
import { AgentLoop, type ActiveModelRuntime } from '../harness/loop.js'
import {
  PermissionGate,
  type DenialStateStore,
  type PermissionMode,
  type PermissionPrompt,
  type PermissionRule,
} from '../harness/permissions.js'
import type { AutoModeConfig } from '../harness/autoClassifier.js'
import { MemoryRecordStream, type RecordStream } from '../harness/recordStream.js'
import { getSubagentTranscriptPath, SidechainRecordStream } from '../harness/sidechainRecordStream.js'
import { ToolRunner } from '../harness/toolRunner.js'
import type { ContextManagementConfig } from '../prompts/budget.js'
import type { SkillDefinition } from '../services/skills/skillsService.js'
import {
  GitSubagentWorktreeManager,
  type SubagentIsolation,
  type SubagentWorktreeLease,
  type SubagentWorktreeManager,
} from '../services/agents/subagentWorktree.js'
import type { CacheRuntime } from '../harness/cacheControl.js'
import { runLifecycleHooks, type Hooks } from '../harness/hooks.js'
import type { AgentRunResult, ModelProvider, SessionRecord, SubagentTaskStatus, TokenUsage, Tool, ToolContext, ToolProgressEvent } from '../harness/types.js'
import { countSessionRecordTokens } from '../prompts/budget.js'
import { formatTokenCount } from './display.js'

// Tools that no sub-agent should ever call directly.
export const ALL_AGENT_DISALLOWED_TOOLS = [
  'Agent',
  'EnterPlanMode',
  'ExitPlanMode',
  'AskUserQuestion',
] as const

/** @deprecated Use ALL_AGENT_DISALLOWED_TOOLS instead. */
export const NESTED_AGENT_FORBIDDEN_TOOLS = ALL_AGENT_DISALLOWED_TOOLS

// Whitelist for background/async agents. Only these tools are available.
export const ASYNC_AGENT_ALLOWED_TOOLS = [
  'Read',
  'Glob',
  'Grep',
  'Bash',
  'Write',
  'Edit',
  'MultiEdit',
  'Delete',
  'Skill',
] as const

// Task tracking tools are included because sub-agents share taskState semantics,
// not because they write files.
export const STATEFUL_AGENT_TOOL_NAMES = new Set([
  'Bash',
  'Write',
  'Edit',
  'MultiEdit',
  'Delete',
  'TaskCreate',
  'TaskList',
  'TaskGet',
  'TaskUpdate',
])

export const DEFAULT_AGENT_MAX_TURNS = 30
const FORK_AGENT_MAX_TURNS = 200
const GENERAL_AGENT_MAX_TURNS = 30
const EXPLORE_AGENT_MAX_TURNS = 30
const PLAN_AGENT_MAX_TURNS = 30
export const AGENT_MAX_RESULT_SIZE_CHARS = 32_000
const SUBAGENT_TRANSCRIPT_SUMMARY_CHARS = 8_000
export const FORK_PRELOAD_TOKEN_BUDGET = 50_000
const ONE_SHOT_AGENT_TYPES = new Set(['explore', 'plan'])

export type AgentType = string

export interface BaseAgentDefinition {
  type: string
  description: string
  model?: string
  permissionMode?: PermissionMode
  skills?: readonly string[]
  mcpServers?: readonly string[]
  background?: boolean
  isolation?: SubagentIsolation
  tools?: readonly string[]
  disallowedTools: readonly string[]
  maxTurns: number
  maxResultSizeChars?: number
  isReadOnlyAgent: boolean
  omitProjectContext?: boolean
  criticalSystemReminder?: string
  initialPrompt?: string
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | number
  getSystemPrompt(baseSystem?: string): string | undefined
}

const GENERAL_PURPOSE_AGENT: BaseAgentDefinition = {
  type: 'general',
  description: 'General-purpose read-only sub-agent for isolated research tasks.',
  disallowedTools: ALL_AGENT_DISALLOWED_TOOLS,
  maxTurns: GENERAL_AGENT_MAX_TURNS,
  maxResultSizeChars: AGENT_MAX_RESULT_SIZE_CHARS,
  isReadOnlyAgent: true,
  effort: 'medium',
  getSystemPrompt: (baseSystem) => baseSystem,
}

// Sentinel tag for detecting recursive fork agents
const FORK_AGENT_BOILERPLATE_TAG = '__HANEKAWA_FORK_AGENT__'

const FORK_AGENT_BOILERPLATE = `# Forked Conversation Context
${FORK_AGENT_BOILERPLATE_TAG}
You are running as an isolated fork of the parent conversation. The parent transcript is preloaded before your task, so use it as background context, but do not assume your intermediate work is visible to the parent. Return a concise result that the parent agent can use directly.`

const FORK_AGENT: BaseAgentDefinition = {
  type: 'fork',
  description: 'Read-only sub-agent fork that preloads the parent transcript and shares the parent fork prompt-cache stream.',
  disallowedTools: ALL_AGENT_DISALLOWED_TOOLS,
  maxTurns: FORK_AGENT_MAX_TURNS,
  maxResultSizeChars: AGENT_MAX_RESULT_SIZE_CHARS,
  isReadOnlyAgent: true,
  effort: 'medium',
  getSystemPrompt: (baseSystem) => baseSystem,
}

const EXPLORE_AGENT: BaseAgentDefinition = {
  type: 'explore',
  description: 'Fast read-only code exploration agent for broad search, navigation, and codebase questions.',
  tools: ['Glob', 'Grep', 'Read'],
  disallowedTools: ['Agent', 'Bash', 'Write', 'Edit', 'Delete', 'MultiEdit'],
  maxTurns: EXPLORE_AGENT_MAX_TURNS,
  maxResultSizeChars: AGENT_MAX_RESULT_SIZE_CHARS,
  isReadOnlyAgent: true,
  omitProjectContext: true,
  effort: 'low',
  getSystemPrompt: () => `You are a code exploration specialist for Hanekawa.

=== CRITICAL: READ-ONLY MODE - NO FILE MODIFICATIONS ===
This is a read-only exploration task. You are strictly prohibited from:
- Creating new files.
- Modifying existing files.
- Deleting files.
- Moving or copying files.
- Running any command or tool action that changes project state.

Your role is exclusively to search and analyze existing code. You only have Glob, Grep, and Read, so attempting to edit files or run shell commands will fail.

Your job is to quickly map the relevant facts in the codebase:
- Use Glob for broad file discovery.
- Use Grep for content searches and symbol discovery.
- Use Read when you know which file needs inspection.
- Search with multiple naming conventions before concluding something does not exist.
- Prefer parallel read-only searches when they are independent.
- Adapt your search depth to the caller's requested thoroughness.

Keep your final report concise - under ~500 words.

Return high-signal findings with file paths and line numbers when useful. Avoid generic summaries. Do not propose edits unless the caller explicitly asked for implementation guidance.`,
}

const PLAN_AGENT: BaseAgentDefinition = {
  type: 'plan',
  description: 'Read-only software planning agent for implementation strategy and trade-off analysis.',
  tools: ['Glob', 'Grep', 'Read'],
  disallowedTools: ['Agent', 'Bash', 'Write', 'Edit', 'Delete', 'MultiEdit'],
  maxTurns: PLAN_AGENT_MAX_TURNS,
  maxResultSizeChars: AGENT_MAX_RESULT_SIZE_CHARS,
  isReadOnlyAgent: true,
  omitProjectContext: true,
  effort: 'high',
  getSystemPrompt: () => `You are a software architect and planning specialist for Hanekawa. Your role is to explore the codebase and design implementation plans.

=== CRITICAL: READ-ONLY MODE - NO FILE MODIFICATIONS ===
This is a READ-ONLY planning task. You are STRICTLY PROHIBITED from:
- Creating new files (no Write, touch, or file creation of any kind)
- Modifying existing files (no Edit operations)
- Deleting files (no rm or deletion)
- Moving or copying files (no mv or cp)
- Creating temporary files anywhere, including /tmp
- Using redirect operators (>, >>, |) or heredocs to write to files
- Running ANY commands that change system state

Your role is EXCLUSIVELY to explore the codebase and design implementation plans. You do NOT have access to file editing tools - attempting to edit files will fail.

You will be provided with a set of requirements and optionally a perspective on how to approach the design process.

## Your Process

1. **Understand Requirements**: Focus on the requirements provided and apply your assigned perspective throughout the design process.

2. **Explore Thoroughly**:
   - Read any files provided to you in the initial prompt
   - Find existing patterns and conventions using Glob, Grep, and Read
   - Understand the current architecture
   - Identify similar features as reference
   - Trace through relevant code paths

3. **Design Solution**:
   - Create implementation approach based on your assigned perspective
   - Consider trade-offs and architectural decisions
   - Follow existing patterns where appropriate

4. **Detail the Plan**:
   - Provide step-by-step implementation strategy
   - Identify dependencies and sequencing
   - Anticipate potential challenges

## Required Output

End your response with:

### Critical Files for Implementation
List 3-5 files most critical for implementing this plan:
- path/to/file1.ts
- path/to/file2.ts
- path/to/file3.ts

REMEMBER: You can ONLY explore and plan. You CANNOT and MUST NOT write, edit, or modify any files. You do NOT have access to file editing tools.`,
}

export const BUILT_IN_AGENT_DEFINITIONS = [
  GENERAL_PURPOSE_AGENT,
  FORK_AGENT,
  EXPLORE_AGENT,
  PLAN_AGENT,
] as const

const agentInputSchema = z.object({
  task: z.string().min(1),
  subagent_type: z.string().min(1),
  description: z.string().min(1).optional(),
  run_in_background: z.boolean().optional(),
  name: z.string().min(1).optional(),
  systemPrompt: z.string().optional(),
  maxTurns: z.number().int().min(1).optional(),
  maxOutputTokens: z.number().int().min(1).optional(),
}).strict()

type AgentInput = z.infer<typeof agentInputSchema>

export interface CreateAgentToolOptions {
  provider: ModelProvider
  model: string
  modelKey?: string
  providerName?: string
  promptCacheRetention?: 'in_memory' | '24h'
  fallbackModel?: ActiveModelRuntime
  compactModel?: ActiveModelRuntime
  fallbackRetryDelayMs?: number
  tools(): Tool[]
  permissionPrompt: PermissionPrompt
  permissionMode?(): PermissionMode
  getConfigRules?(): PermissionRule[]
  getSessionRules?(): PermissionRule[]
  denialStateStore?: DenialStateStore
  autoModeConfig?: AutoModeConfig
  cwd: string
  system?: string
  projectContext?: string
  skills?: SkillDefinition[]
  agentDefinitions?: BaseAgentDefinition[]
  loadParentRecords?(): Promise<SessionRecord[]>
  contextManagement?: Partial<ContextManagementConfig>
  isGitRepo?: boolean
  hooks?: Hooks
  cacheRuntime?: CacheRuntime
  resolveSubagentModel?(subagentType: string, requestedModelKey?: string): ActiveModelRuntime | undefined
  onSubagentProgress?(event: ToolProgressEvent): void
  getCompactFailureCount?(): Promise<number>
  setCompactFailureCount?(count: number): Promise<void>
  agentTimeoutMs?: number
  worktreeManager?: SubagentWorktreeManager
}

export function filterToolsForSubAgent(
  tools: Tool[],
  definition: BaseAgentDefinition = GENERAL_PURPOSE_AGENT,
  options?: { isBackground?: boolean },
): Tool[] {
  const allowed = definition.tools ? new Set<string>(definition.tools) : undefined
  const disallowed = new Set<string>(definition.disallowedTools)
  const allowedMcpServers = definition.mcpServers && definition.mcpServers.length > 0
    ? new Set(definition.mcpServers)
    : undefined
  // Always exclude globally forbidden tools regardless of agent definition.
  for (const name of ALL_AGENT_DISALLOWED_TOOLS) {
    disallowed.add(name)
  }

  // For background/async agents, restrict to the async whitelist
  const asyncAllowed = options?.isBackground
    ? new Set<string>(ASYNC_AGENT_ALLOWED_TOOLS)
    : undefined

  return tools.filter((tool) => {
    if (allowedMcpServers) {
      const mcpServer = mcpServerNameForTool(tool.name)
      if (mcpServer && !allowedMcpServers.has(mcpServer)) return false
    }
    if (allowed && !allowed.has(tool.name)) return false
    if (!allowed && isUnsafeForReadOnlySubAgent(tool)) return false
    if (disallowed.has(tool.name)) return false
    // For background agents, only allow tools in the async whitelist
    if (asyncAllowed && !asyncAllowed.has(tool.name)) return false
    return allowed !== undefined ? true : tool.isReadOnly === true
  })
}

export function infersReadOnlyAgentFromTools(tools: readonly string[] | undefined): boolean {
  return tools === undefined || !tools.some((tool) => STATEFUL_AGENT_TOOL_NAMES.has(tool))
}

function isUnsafeForReadOnlySubAgent(tool: Tool): boolean {
  return tool.isDestructive === true || tool.riskLevel === 'dangerous'
}

function mcpServerNameForTool(toolName: string): string | undefined {
  if (!toolName.startsWith('mcp__')) return undefined
  const parts = toolName.split('__')
  return parts.length >= 3 && parts[1] ? parts[1] : undefined
}

export function createAgentTool(options: CreateAgentToolOptions): Tool {
  const agentDefinitions = Object.freeze([...(options.agentDefinitions ?? BUILT_IN_AGENT_DEFINITIONS)])
  return {
    name: 'Agent',
    description: buildAgentToolDescription(agentDefinitions),
    inputSchema: agentInputSchema,
    riskLevel: 'safe',
    maxResultSizeChars: undefined,
    userFacingName(input) {
      const subagentType = typeof input === 'object' && input !== null
        ? (input as { subagent_type?: unknown }).subagent_type
        : undefined
      return typeof subagentType === 'string' ? `${subagentType} agent` : 'Agent'
    },
    getToolUseSummary(input) {
      const value = typeof input === 'object' && input !== null
        ? input as { description?: unknown; name?: unknown; task?: unknown }
        : undefined
      const summary = agentBriefSummary(value)
      return summary ? truncateMiddle(summary, 36) : null
    },
    getActivityDescription(input) {
      const subagentType = typeof input === 'object' && input !== null
        ? (input as { subagent_type?: unknown }).subagent_type
        : undefined
      return typeof subagentType === 'string' ? `Running ${subagentType} agent` : 'Running agent'
    },
    isConcurrencySafeInput(input) {
      const subagentType = typeof input === 'object' && input !== null
        ? (input as { subagent_type?: unknown }).subagent_type
        : undefined
      return typeof subagentType === 'string'
        && getAgentDefinition(agentDefinitions, subagentType)?.isReadOnlyAgent === true
    },
    async execute(input, context) {
      const parsed = agentInputSchema.parse(input)
      try {
        const agentDefinition = getAgentDefinition(agentDefinitions, parsed.subagent_type)
        if (!agentDefinition) {
          throw new Error(`Unknown subagent_type "${parsed.subagent_type}". Available types: ${formatAgentTypes(agentDefinitions)}.`)
        }
        validateSubagentIsolation(agentDefinition)

        const subAgentId = randomUUID()
        const runInBackground = parsed.run_in_background ?? agentDefinition.background ?? false
        if (runInBackground) {
          const transcriptPath = getSubagentTranscriptPath(options.cwd, context.sessionId, subAgentId)
          const plannedModel = resolveSubagentModelLabel(options, parsed.subagent_type, agentDefinition)
          await appendSubagentTaskRecord(context, parsed, subAgentId, 'running', {
            transcriptPath,
            ...(plannedModel ? { model: plannedModel } : {}),
            ...plannedIsolationDetails(options, agentDefinition, context.sessionId, subAgentId),
          })
          void runBackgroundSubagent({
            options,
            parsed,
            agentDefinition,
            context,
            subAgentId,
            transcriptPath,
          })
          const description = subagentDescription(parsed)
          return {
            ok: true,
            content: `Started ${parsed.subagent_type} sub-agent "${description}" in the background.`,
            metadata: {
              display: {
                summary: `${parsed.subagent_type} background agent started`,
                detail: [
                  `Agent ID: ${subAgentId}`,
                  `Transcript: ${transcriptPath}`,
                  plannedIsolationDetails(options, agentDefinition, context.sessionId, subAgentId).worktreePath
                    ? `Worktree: ${plannedIsolationDetails(options, agentDefinition, context.sessionId, subAgentId).worktreePath}`
                    : undefined,
                ].filter(Boolean).join('\n'),
              },
            },
          }
        }

        const startedAtMs = Date.now()
        const run = await runSubagent({
          options,
          parsed,
          agentDefinition,
          context,
          subAgentId,
          recordStream: new MemoryRecordStream(),
          linkParentAbort: true,
        })
        const durationMs = Date.now() - startedAtMs
        await context.appendRecord?.(run.transcriptRecord)
        const content = appendHookOutputToToolResult(
          appendWorktreeNoticeToToolResult(
            appendTruncationNotice(
              applyAgentResultBudget(run.result.content, agentDefinition.maxResultSizeChars),
              run.result,
            ),
            run.worktree,
          ),
          run.stopHookOutput,
        )
        const doneSummary = formatAgentDoneSummary(run.transcriptRecord.toolUseCount, run.result.usage, durationMs)
        return {
          ok: true,
          content,
          metadata: {
            display: {
              summary: doneSummary,
              ...(run.transcriptRecord.model ? { headerSuffix: run.transcriptRecord.model } : {}),
            },
            subagent: {
              type: parsed.subagent_type,
              agentId: subAgentId,
              ...(run.transcriptRecord.model ? { model: run.transcriptRecord.model } : {}),
              usage: run.result.usage,
              toolUseCount: run.transcriptRecord.toolUseCount,
              durationMs,
              verdict: run.verdict,
              criticalFiles: run.criticalFiles,
              ...(run.result.stopReason ? { stopReason: run.result.stopReason } : {}),
              ...(run.result.truncated ? { truncated: true } : {}),
              ...(ONE_SHOT_AGENT_TYPES.has(parsed.subagent_type) ? { suppressContextSummary: true } : {}),
              ...(run.worktree
                ? {
                    isolation: run.worktree.isolation,
                    worktreePath: run.worktree.path,
                    worktreeBaseRef: run.worktree.baseRef,
                    worktreeChangeSummary: run.worktree.changeSummary,
                  }
                : {}),
            },
          },
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (error instanceof ForkPreloadError) {
          return { ok: false, content: `Fork failed: ${message}`, errorCode: 'execution_failed' }
        }
        return { ok: false, content: `Sub-agent failed: ${message}`, errorCode: errorCodeFor(error) }
      }
    },
  }
}

interface RunSubagentOptions {
  options: CreateAgentToolOptions
  parsed: AgentInput
  agentDefinition: BaseAgentDefinition
  context: ToolContext
  subAgentId: string
  recordStream: RecordStream
  linkParentAbort: boolean
  transcriptPath?: string
  isBackground?: boolean
}

interface RunSubagentResult {
  result: AgentRunResult
  transcriptRecord: Extract<SessionRecord, { type: 'subagent_transcript' }>
  stopHookOutput?: string
  verdict?: 'PASS' | 'FAIL' | 'PARTIAL'
  criticalFiles: string[]
  worktree?: SubagentWorktreeSummary
}

interface SubagentWorktreeSummary extends SubagentWorktreeLease {
  changeSummary: string
}

async function runSubagent({
  options,
  parsed,
  agentDefinition,
  context,
  subAgentId,
  recordStream,
  linkParentAbort,
  transcriptPath,
  isBackground = false,
}: RunSubagentOptions): Promise<RunSubagentResult> {
  const isForkAgent = parsed.subagent_type === 'fork'

  // Fork recursion prevention: check if parent records already contain fork boilerplate
  if (isForkAgent) {
    try {
      const parentRecords = await options.loadParentRecords?.()
      if (parentRecords?.some(r =>
        r.type === 'message' && typeof r.content === 'string' && r.content.includes(FORK_AGENT_BOILERPLATE_TAG)
      )) {
        throw new Error('Recursive fork agent detected. A fork agent cannot spawn another fork agent.')
      }
    } catch (error) {
      // Only re-throw our recursion error, ignore other load errors
      if (error instanceof Error && error.message.includes('Recursive fork agent')) {
        throw error
      }
    }
  }

  const cacheSource = isForkAgent ? forkCacheSource(context.sessionId) : agentCacheSource(subAgentId)
  const abortController = new AbortController()
  const timeout = options.agentTimeoutMs === undefined
    ? undefined
    : setTimeout(() => {
        abortController.abort(createAbortError(`Sub-agent timed out after ${options.agentTimeoutMs}ms`))
      }, options.agentTimeoutMs)
  const forwardParentAbort = () => abortController.abort(context.abortSignal?.reason)
  if (linkParentAbort) {
    if (context.abortSignal?.aborted) {
      forwardParentAbort()
    } else {
      context.abortSignal?.addEventListener('abort', forwardParentAbort, { once: true })
    }
  }

  try {
    const worktree = await createSubagentWorktree(options, agentDefinition, context.sessionId, subAgentId)
    const effectiveCwd = worktree?.path ?? options.cwd
    const subagentRuntime = resolveSubagentRuntime(options, parsed.subagent_type, agentDefinition)
    const subTools = filterToolsForSubAgent(options.tools(), agentDefinition, { isBackground })
    const permissionGate = new PermissionGate(options.permissionPrompt, options.getConfigRules?.(), {
      mode: resolveSubagentPermissionMode(options, agentDefinition, isBackground),
      denialStateStore: readonlyDenialStateStore(options.denialStateStore),
      cwd: effectiveCwd,
      autoModeConfig: options.autoModeConfig,
    })
    permissionGate.addSessionRules(options.getSessionRules?.() ?? [])
    const toolRunner = new ToolRunner(subTools, permissionGate, {
      onRecord: async (record) => {
        await recordStream.append(record)
      },
      onProgress: (event) => {
        options.onSubagentProgress?.({
          ...event,
          source: {
            type: 'subagent',
            agentType: parsed.subagent_type,
            agentId: subAgentId,
          },
        })
      },
    }, {
      preToolUse: options.hooks?.preToolUse,
    })
    const toolContext = createSubAgentToolContext(context, subAgentId, abortController.signal, effectiveCwd)
    if (isForkAgent) {
      const forkUserPrefix = buildForkAgentUserPrefix(parsed.systemPrompt, parsed.maxOutputTokens)
      if (forkUserPrefix) {
        await recordStream.append({
          id: randomUUID(),
          type: 'message',
          role: 'user',
          content: forkUserPrefix,
          createdAt: new Date().toISOString(),
        })
      }
    }
    if (agentDefinition.initialPrompt) {
      await recordStream.append({
        id: randomUUID(),
        type: 'message',
        role: 'user',
        content: agentDefinition.initialPrompt,
        createdAt: new Date().toISOString(),
      })
    }
    await appendSubagentHookOutput(
      recordStream,
      await runLifecycleHooks(
        options.hooks?.subagentStart,
        'subagentStart',
        {
          agentId: subAgentId,
          agentType: parsed.subagent_type,
          task: parsed.task,
        },
        toolContext,
        abortController.signal,
        parsed.subagent_type,
      ),
      'subagentStart',
    )
    const preloadRecords = isForkAgent ? await loadForkPreloadRecords(options) : undefined
    const loop = new AgentLoop({
      provider: subagentRuntime.provider,
      model: subagentRuntime.model,
      modelKey: subagentRuntime.modelKey,
      tools: subTools,
      contextBuilder: new ContextBuilder(undefined, options.contextManagement),
      toolRunner,
      toolContext,
      system: buildAgentSystemPrompt(agentDefinition, parsed.systemPrompt, options.system, parsed.maxOutputTokens, worktree),
      criticalSystemReminder: agentDefinition.criticalSystemReminder,
      projectContext: agentDefinition.omitProjectContext ? undefined : options.projectContext,
      skills: skillsForSubAgent(options.skills, agentDefinition),
      promptCacheRetention: subagentRuntime.promptCacheRetention,
      contextManagement: options.contextManagement,
      isGitRepo: options.isGitRepo,
      maxTurns: parsed.maxTurns ?? agentDefinition.maxTurns,
      maxTurnsExceededBehavior: 'partial',
      maxOutputTokens: parsed.maxOutputTokens,
      thinking: { type: 'adaptive' },
      effort: agentDefinition.effort as 'low' | 'medium' | 'high' | 'xhigh' | 'max' | undefined,
      fallbackModel: options.fallbackModel,
      compactModel: options.compactModel,
      fallbackRetryDelayMs: options.fallbackRetryDelayMs,
      hooks: options.hooks,
      cacheRuntime: options.cacheRuntime,
      cacheSource,
      preloadRecords,
      permissionMode: () => permissionGate.getMode(),
      getCompactFailureCount: options.getCompactFailureCount,
      setCompactFailureCount: options.setCompactFailureCount,
      recordStream,
    })
    const result = await loop.run(parsed.task, abortController.signal)
    const transcriptRecords = await recordStream.load()
    const transcriptStats = summarizeTranscriptRecords(transcriptRecords)
    const verdict = extractVerdict(result.content)
    const criticalFiles = extractCriticalFiles(result.content)
    const summary = appendTruncationNotice(
      applyAgentResultBudget(result.content, SUBAGENT_TRANSCRIPT_SUMMARY_CHARS),
      result,
    )
    const worktreeSummary = worktree
      ? {
          ...worktree,
          changeSummary: await summarizeSubagentWorktree(options, worktree),
        }
      : undefined
    const stopHookOutput = formatSubagentHookOutput(
      await runLifecycleHooks(
        options.hooks?.subagentStop,
        'subagentStop',
        {
          agentId: subAgentId,
          agentType: parsed.subagent_type,
          response: result.content,
        },
        toolContext,
        abortController.signal,
        parsed.subagent_type,
      ),
      'subagentStop',
    )

    return {
      result,
      stopHookOutput,
      verdict,
      criticalFiles,
      transcriptRecord: {
        id: randomUUID(),
        type: 'subagent_transcript',
        agentId: subAgentId,
        subagentType: parsed.subagent_type,
        model: subagentRuntime.model,
        parentToolUseId: context.currentToolUseId,
        ...(transcriptPath ? { transcriptPath } : {}),
        status: 'completed',
        ...(result.stopReason ? { stopReason: result.stopReason } : {}),
        ...(result.truncated ? { truncated: true } : {}),
        summary,
        recordCount: transcriptStats.recordCount,
        messageCount: transcriptStats.messageCount,
        toolUseCount: transcriptStats.toolUseCount,
        toolResultCount: transcriptStats.toolResultCount,
        ...(verdict ? { verdict } : {}),
        ...(criticalFiles.length > 0 ? { criticalFiles } : {}),
        ...worktreeRecordFields(worktreeSummary),
        records: [],
        usage: result.usage,
        createdAt: new Date().toISOString(),
        turnId: context.currentTurnId,
      },
      worktree: worktreeSummary,
    }
  } finally {
    if (timeout) clearTimeout(timeout)
    if (linkParentAbort) context.abortSignal?.removeEventListener('abort', forwardParentAbort)
    if (!isForkAgent) resetCacheBreakDetection(cacheSource)
  }
}

async function runBackgroundSubagent(input: {
  options: CreateAgentToolOptions
  parsed: AgentInput
  agentDefinition: BaseAgentDefinition
  context: ToolContext
  subAgentId: string
  transcriptPath: string
}): Promise<void> {
  const { options, parsed, agentDefinition, context, subAgentId, transcriptPath } = input
  const startedAtMs = Date.now()
  try {
    const run = await runSubagent({
      options,
      parsed,
      agentDefinition,
      context,
      subAgentId,
      transcriptPath,
      recordStream: new SidechainRecordStream(transcriptPath),
      linkParentAbort: false,
      isBackground: true,
    })
    await context.appendRecord?.(run.transcriptRecord)
    await appendSubagentTaskRecord(context, parsed, subAgentId, 'completed', {
      transcriptPath,
      ...(run.transcriptRecord.model ? { model: run.transcriptRecord.model } : {}),
      summary: run.transcriptRecord.summary,
      usage: run.result.usage,
      toolUseCount: run.transcriptRecord.toolUseCount,
      durationMs: Date.now() - startedAtMs,
      verdict: run.verdict,
      criticalFiles: run.criticalFiles,
      ...worktreeTaskDetails(run.worktree),
    })
    await context.appendRecord?.({
      id: randomUUID(),
      type: 'message',
      role: 'assistant',
      content: formatBackgroundCompletionMessage(parsed, run.transcriptRecord.summary, run.verdict, run.worktree),
      createdAt: new Date().toISOString(),
      turnId: context.currentTurnId,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const status: SubagentTaskStatus = errorCodeFor(error) === 'aborted' ? 'cancelled' : 'failed'
    const failedModel = resolveSubagentModelLabel(options, parsed.subagent_type, agentDefinition)
    await appendSubagentTaskRecord(context, parsed, subAgentId, status, {
      transcriptPath,
      ...(failedModel ? { model: failedModel } : {}),
      ...plannedIsolationDetails(options, agentDefinition, context.sessionId, subAgentId),
      error: message,
    })
    await context.appendRecord?.({
      id: randomUUID(),
      type: 'message',
      role: 'assistant',
      content: `Background ${parsed.subagent_type} agent "${subagentDescription(parsed)}" ${status}: ${message}`,
      createdAt: new Date().toISOString(),
      turnId: context.currentTurnId,
    })
  }
}

async function appendSubagentTaskRecord(
  context: ToolContext,
  parsed: AgentInput,
  subAgentId: string,
  status: SubagentTaskStatus,
  details: {
    transcriptPath?: string
    model?: string
    summary?: string
    error?: string
    usage?: TokenUsage
    toolUseCount?: number
    durationMs?: number
    verdict?: 'PASS' | 'FAIL' | 'PARTIAL'
    criticalFiles?: string[]
    isolation?: 'worktree'
    worktreePath?: string
    worktreeBaseRef?: string
    worktreeChangeSummary?: string
  } = {},
): Promise<void> {
  await context.appendRecord?.({
    id: randomUUID(),
    type: 'subagent_task',
    agentId: subAgentId,
    subagentType: parsed.subagent_type,
    ...(details.model ? { model: details.model } : {}),
    status,
    description: subagentDescription(parsed),
    task: parsed.task,
    ...(parsed.name ? { name: parsed.name } : {}),
    parentToolUseId: context.currentToolUseId,
    ...(details.transcriptPath ? { transcriptPath: details.transcriptPath } : {}),
    ...(details.summary ? { summary: details.summary } : {}),
    ...(details.error ? { error: details.error } : {}),
    ...(details.usage ? { usage: details.usage } : {}),
    ...(typeof details.toolUseCount === 'number' ? { toolUseCount: details.toolUseCount } : {}),
    ...(typeof details.durationMs === 'number' ? { durationMs: details.durationMs } : {}),
    ...(details.verdict ? { verdict: details.verdict } : {}),
    ...(details.criticalFiles && details.criticalFiles.length > 0 ? { criticalFiles: details.criticalFiles } : {}),
    ...(details.isolation ? { isolation: details.isolation } : {}),
    ...(details.worktreePath ? { worktreePath: details.worktreePath } : {}),
    ...(details.worktreeBaseRef ? { worktreeBaseRef: details.worktreeBaseRef } : {}),
    ...(details.worktreeChangeSummary ? { worktreeChangeSummary: details.worktreeChangeSummary } : {}),
    createdAt: new Date().toISOString(),
    turnId: context.currentTurnId,
  })
}

function subagentDescription(input: AgentInput): string {
  return input.description?.trim() || input.name?.trim() || truncateMiddle(input.task.trim(), 80)
}

function agentBriefSummary(input: { description?: unknown; name?: unknown; task?: unknown } | undefined): string | undefined {
  if (!input) return undefined
  for (const key of ['description', 'name', 'task'] as const) {
    const value = input[key]
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  }
  return undefined
}

function formatBackgroundCompletionMessage(
  parsed: AgentInput,
  summary: string | undefined,
  verdict: 'PASS' | 'FAIL' | 'PARTIAL' | undefined,
  worktree: SubagentWorktreeSummary | undefined,
): string {
  const head = `Background ${parsed.subagent_type} agent "${subagentDescription(parsed)}" completed${verdict ? ` (${verdict})` : ''}.`
  const body = summary?.trim()
  const worktreeNotice = formatWorktreeNotice(worktree)
  return [head, worktreeNotice, body ? applyAgentResultBudget(body, 1200) : undefined]
    .filter((part): part is string => Boolean(part))
    .join('\n\n')
}

function truncateMiddle(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value
  const keep = Math.max(1, Math.floor((maxLength - 3) / 2))
  return `${value.slice(0, keep)}...${value.slice(value.length - keep)}`
}

async function loadForkPreloadRecords(options: CreateAgentToolOptions): Promise<SessionRecord[] | undefined> {
  try {
    const records = await options.loadParentRecords?.()
    return records ? prepareForkPreloadRecords(records) : undefined
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new ForkPreloadError(message)
  }
}

function validateSubagentIsolation(definition: BaseAgentDefinition): void {
  if (definition.isolation === undefined) return
  if (definition.isolation !== 'worktree') {
    throw new Error(`Unsupported isolation for subagent "${definition.type}": ${String(definition.isolation)}`)
  }
  if (definition.isReadOnlyAgent) {
    throw new Error(`Subagent "${definition.type}" cannot use worktree isolation while marked read-only. Set isReadOnlyAgent: false or include write-capable tools.`)
  }
}

function plannedIsolationDetails(
  options: CreateAgentToolOptions,
  definition: BaseAgentDefinition,
  parentSessionId: string,
  agentId: string,
): { isolation?: 'worktree'; worktreePath?: string } {
  if (definition.isolation !== 'worktree') return {}
  return {
    isolation: 'worktree',
    worktreePath: worktreeManager(options).getPath({
      cwd: options.cwd,
      parentSessionId,
      agentId,
    }),
  }
}

async function createSubagentWorktree(
  options: CreateAgentToolOptions,
  definition: BaseAgentDefinition,
  parentSessionId: string,
  agentId: string,
): Promise<SubagentWorktreeLease | undefined> {
  if (definition.isolation !== 'worktree') return undefined
  return worktreeManager(options).create({
    cwd: options.cwd,
    parentSessionId,
    agentId,
  })
}

async function summarizeSubagentWorktree(
  options: CreateAgentToolOptions,
  worktree: SubagentWorktreeLease,
): Promise<string> {
  try {
    return await worktreeManager(options).summarize({ worktreePath: worktree.path })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return `Unable to summarize worktree changes: ${message}`
  }
}

function worktreeManager(options: CreateAgentToolOptions): SubagentWorktreeManager {
  return options.worktreeManager ?? new GitSubagentWorktreeManager()
}

function worktreeRecordFields(worktree: SubagentWorktreeSummary | undefined): {
  isolation?: 'worktree'
  worktreePath?: string
  worktreeBaseRef?: string
  worktreeChangeSummary?: string
} {
  if (!worktree) return {}
  return {
    isolation: worktree.isolation,
    worktreePath: worktree.path,
    worktreeBaseRef: worktree.baseRef,
    worktreeChangeSummary: worktree.changeSummary,
  }
}

function worktreeTaskDetails(worktree: SubagentWorktreeSummary | undefined): {
  isolation?: 'worktree'
  worktreePath?: string
  worktreeBaseRef?: string
  worktreeChangeSummary?: string
} {
  return worktreeRecordFields(worktree)
}

function resolveSubagentRuntime(
  options: CreateAgentToolOptions,
  subagentType: string,
  definition: BaseAgentDefinition,
): ActiveModelRuntime {
  const parentRuntime = {
    provider: options.provider,
    model: options.model,
    modelKey: options.modelKey,
    providerName: options.providerName,
    promptCacheRetention: options.promptCacheRetention,
  }

  // Environment variable override: check per-type first, then generic
  const envModelType = process.env[`MYAGENT_SUBAGENT_MODEL_${subagentType.toUpperCase()}`]?.trim()
  const envModelGeneric = process.env.MYAGENT_SUBAGENT_MODEL?.trim()
  const envModel = envModelType || envModelGeneric
  if (envModel) {
    try {
      const runtime = options.resolveSubagentModel?.(subagentType, envModel)
      if (runtime) return runtime
    } catch {
      console.warn(`MYAGENT_SUBAGENT_MODEL="${envModel}" could not be resolved for subagent "${subagentType}", falling back to default routing`)
    }
  }

  const requestedModelKey = definition.model?.trim()
  if (requestedModelKey === 'inherit') return parentRuntime

  if (requestedModelKey) {
    try {
      const runtime = options.resolveSubagentModel?.(subagentType, requestedModelKey)
      if (runtime) return runtime
    } catch {
      // Re-throw below with a subagent-specific message.
    }
    throw new Error(`Unknown model for subagent "${subagentType}": ${requestedModelKey}`)
  }

  return options.resolveSubagentModel?.(subagentType) ?? parentRuntime
}

function resolveSubagentModelLabel(
  options: CreateAgentToolOptions,
  subagentType: string,
  definition: BaseAgentDefinition,
): string | undefined {
  try {
    return resolveSubagentRuntime(options, subagentType, definition).model
  } catch {
    return undefined
  }
}

function resolveSubagentPermissionMode(
  options: CreateAgentToolOptions,
  definition: BaseAgentDefinition,
  runInBackground: boolean = false,
): PermissionMode | undefined {
  const parentMode = options.permissionMode?.()
  if (parentMode === 'bypass') return 'bypass'
  if (definition.permissionMode) return definition.permissionMode
  // Background agents default to 'auto' mode to avoid permission prompts
  if (runInBackground) return 'auto'
  return parentMode
}

function skillsForSubAgent(
  skills: SkillDefinition[] | undefined,
  definition: BaseAgentDefinition,
): SkillDefinition[] | undefined {
  if (!skills || !definition.skills || definition.skills.length === 0) return skills

  const requested = new Set(definition.skills)
  const found = new Set<string>()
  const next = skills.map((skill) => {
    if (!requested.has(skill.name)) return skill
    found.add(skill.name)
    return { ...skill, inclusion: 'always' as const }
  })

  for (const name of requested) {
    if (!found.has(name)) {
      console.warn(`Custom agent '${definition.type}' references missing skill '${name}'`)
    }
  }

  return next
}

class ForkPreloadError extends Error {
  constructor(message: string) {
    super(`parent records load error: ${message}`)
    this.name = 'ForkPreloadError'
  }
}

function readonlyDenialStateStore(store: DenialStateStore | undefined): DenialStateStore | undefined {
  if (!store) return undefined
  return {
    getDenialState: () => store.getDenialState(),
    setDenialState: async () => {},
  }
}

function summarizeTranscriptRecords(records: SessionRecord[]): {
  recordCount: number
  messageCount: number
  toolUseCount: number
  toolResultCount: number
} {
  let messageCount = 0
  let toolUseCount = 0
  let toolResultCount = 0
  for (const record of records) {
    if (record.type === 'message') messageCount += 1
    if (record.type === 'tool_use') toolUseCount += 1
    if (record.type === 'tool_result') toolResultCount += 1
  }
  return {
    recordCount: records.length,
    messageCount,
    toolUseCount,
    toolResultCount,
  }
}

async function appendSubagentHookOutput(
  recordStream: RecordStream,
  result: Awaited<ReturnType<typeof runLifecycleHooks>>,
  hookName: 'subagentStart' | 'subagentStop',
): Promise<void> {
  const content = formatSubagentHookOutput(result, hookName)
  if (!content) return

  await recordStream.append({
    id: randomUUID(),
    type: 'message',
    role: 'user',
    content,
    createdAt: new Date().toISOString(),
  })
}

function formatSubagentHookOutput(
  result: Awaited<ReturnType<typeof runLifecycleHooks>>,
  hookName: 'subagentStart' | 'subagentStop',
): string | undefined {
  const blocks: string[] = []
  if (result.stdout.trim()) blocks.push(result.stdout.trim())
  if (result.failures.length > 0) blocks.push(`Hook failures:\n${result.failures.join('\n')}`)
  if (result.blockingErrors.length > 0) blocks.push(`Hook blocking errors:\n${result.blockingErrors.join('\n')}`)
  if (blocks.length === 0) return undefined

  return `<system-reminder>${hookName} hook output:\n${blocks.join('\n\n')}</system-reminder>`
}

function appendHookOutputToToolResult(content: string, hookOutput: string | undefined): string {
  return hookOutput ? `${content}\n\n${hookOutput}` : content
}

function appendWorktreeNoticeToToolResult(content: string, worktree: SubagentWorktreeSummary | undefined): string {
  const notice = formatWorktreeNotice(worktree)
  return notice ? `${content}\n\n${notice}` : content
}

function formatAgentDoneSummary(
  toolUseCount: number | undefined,
  usage: TokenUsage | undefined,
  durationMs: number,
): string {
  const parts: string[] = []
  if (typeof toolUseCount === 'number') {
    parts.push(`${toolUseCount} ${toolUseCount === 1 ? 'tool use' : 'tool uses'}`)
  }
  if (usage) {
    const total = (usage.inputTokens ?? 0)
      + (usage.cacheReadInputTokens ?? 0)
      + (usage.outputTokens ?? 0)
    if (total > 0) parts.push(`${formatTokenCount(total)} tokens`)
  }
  if (durationMs >= 0) {
    parts.push(`${Math.max(1, Math.round(durationMs / 1000))}s`)
  }
  return parts.length > 0 ? `Done (${parts.join(' \u00b7 ')})` : 'Done'
}

function appendTruncationNotice(content: string, result: AgentRunResult): string {
  if (!result.truncated) return content
  if (result.stopReason === 'max_turns') return content
  if (result.stopReason !== 'max_tokens') return `${content}\n\n[Sub-agent output may be incomplete.]`
  return `${content}\n\n[Sub-agent output may be incomplete: model stopped because it reached max output tokens.]`
}

function formatWorktreeNotice(worktree: SubagentWorktreeSummary | undefined): string | undefined {
  if (!worktree) return undefined
  return [
    `Worktree: ${worktree.path}`,
    `Base ref: ${worktree.baseRef}`,
    'Change summary:',
    worktree.changeSummary,
  ].join('\n')
}

function extractVerdict(content: string): 'PASS' | 'FAIL' | 'PARTIAL' | undefined {
  const match = /^VERDICT:\s*(PASS|FAIL|PARTIAL)\s*$/im.exec(content)
  return match?.[1] as 'PASS' | 'FAIL' | 'PARTIAL' | undefined
}

function extractCriticalFiles(content: string): string[] {
  const lines = content.split(/\r?\n/)
  const headingIndex = lines.findIndex((line) => /^#{1,6}\s+Critical Files for Implementation\s*$/i.test(line.trim()))
  if (headingIndex === -1) return []

  const files: string[] = []
  for (const line of lines.slice(headingIndex + 1)) {
    const trimmed = line.trim()
    if (/^#{1,6}\s+/.test(trimmed)) break
    if (/^VERDICT:\s*(PASS|FAIL|PARTIAL)\s*$/i.test(trimmed)) break
    if (!trimmed) continue

    const normalized = trimmed
      .replace(/^[-*+]\s+/, '')
      .replace(/^\d+[.)]\s+/, '')
      .replace(/^`([^`]+)`(?:\s+.*)?$/, '$1')
      .replace(/^([^:\s]+:\d+)(?:\s+.*)?$/, '$1')
      .trim()

    if (isCriticalFilePathCandidate(normalized)) files.push(normalized)
    if (files.length >= 5) break
  }

  return files
}

function isCriticalFilePathCandidate(value: string): boolean {
  if (/\s/.test(value)) return false
  return /[\\/]/.test(value) || /(?:^|[\\/])[^\\/]+\.[^\\/.:]+(?::\d+)?$/.test(value)
}

export function getAgentDefinition(
  definitions: readonly BaseAgentDefinition[],
  type: string,
): BaseAgentDefinition | undefined {
  return definitions.find((definition) => definition.type === type)
}

function buildAgentSystemPrompt(
  definition: BaseAgentDefinition,
  overrideSystemPrompt: string | undefined,
  baseSystem: string | undefined,
  maxOutputTokens: number | undefined,
  worktree: SubagentWorktreeLease | undefined,
): string | undefined {
  const outputLimitPrompt = maxOutputTokens === undefined
    ? undefined
    : `Keep your final report under approximately ${maxOutputWords(maxOutputTokens)} words.`
  const isolationPrompt = worktree ? buildWorktreeIsolationPrompt(worktree) : undefined

  if (definition.type === 'general') {
    const generalPrompt = overrideSystemPrompt ?? definition.getSystemPrompt(baseSystem)
    return joinPromptParts([generalPrompt, isolationPrompt, outputLimitPrompt])
  }

  if (definition.type === 'fork') {
    return joinPromptParts([definition.getSystemPrompt(baseSystem), isolationPrompt])
  }

  const parts = [
    definition.getSystemPrompt(baseSystem),
    overrideSystemPrompt ? `# Additional caller instructions\n${overrideSystemPrompt}` : undefined,
    isolationPrompt,
    outputLimitPrompt,
  ]

  return joinPromptParts(parts)
}

function buildForkAgentUserPrefix(
  overrideSystemPrompt: string | undefined,
  maxOutputTokens: number | undefined,
): string | undefined {
  const outputLimitPrompt = maxOutputTokens === undefined
    ? undefined
    : `Keep your final report under approximately ${maxOutputWords(maxOutputTokens)} words.`
  return joinPromptParts([
    FORK_AGENT_BOILERPLATE,
    overrideSystemPrompt ? `# Additional caller instructions\n${overrideSystemPrompt}` : undefined,
    outputLimitPrompt,
  ])
}

export function prepareForkPreloadRecords(
  records: readonly SessionRecord[],
  tokenBudget = FORK_PRELOAD_TOKEN_BUDGET,
): SessionRecord[] {
  const visibleRecords = records.filter((record) => record.type !== 'subagent_transcript')
  const selected: SessionRecord[] = []
  let used = 0

  for (const record of [...visibleRecords].reverse()) {
    const tokens = countSessionRecordTokens(record)
    if (selected.length > 0 && used + tokens > tokenBudget) break
    selected.push(record)
    used += tokens
    if (used >= tokenBudget) break
  }

  return selected.reverse()
}

function buildAgentToolDescription(definitions: readonly BaseAgentDefinition[]): string {
  const typeDescriptions = definitions
    .map((definition) => `"${definition.type}" (${[definition.description, formatDefinitionCapabilities(definition)].filter(Boolean).join('; ')})`)
    .join(', ')
  return [
    'Run a typed sub-agent on an isolated task. Use this for complex, multi-step research, exploration, or planning work whose intermediate tool output does not need to stay in the main context. Cannot spawn nested agents.',
    `Available subagent_type values: ${typeDescriptions}.`,
    'Always pass an explicit subagent_type.',
    'For long-running or independent work, set run_in_background=true and include a short description. Background agents return immediately and send a completion notification later.',
    '',
    'When NOT to use the Agent tool:',
    '- If you already know the exact file path to inspect, use Read instead.',
    '- If you are searching for a symbol, class, function, or string in a known area, use Grep or Glob directly.',
    '- If the task only touches one small file set, inspect those files yourself.',
    '- Do not use an agent for work unrelated to the available agent descriptions.',
    '',
    'Writing effective sub-agent prompts:',
    '- Brief the agent like a smart colleague who just walked into the room: it has not seen this conversation, does not know what you tried, and does not know why the task matters.',
    '- Explain the goal, why it matters, what you already know, what you ruled out, and the output shape you need. If you need a short response, say so.',
    '- For lookups, hand over the exact target. For investigations, hand over the question; prescribed steps become dead weight when the premise is wrong.',
    '- Terse command-style prompts produce shallow, generic work.',
    '- Never delegate understanding. Do not write prompts like "based on your findings, fix the bug" or "based on the research, implement it." Synthesize the agent result yourself, then decide the specific change.',
  ].join('\n')
}

function formatAgentTypes(definitions: readonly BaseAgentDefinition[]): string {
  return definitions.map((definition) => definition.type).join(', ')
}

function buildWorktreeIsolationPrompt(worktree: SubagentWorktreeLease): string {
  return [
    '# Worktree Isolation',
    `You are running inside an isolated git worktree at: ${worktree.path}`,
    `Base ref: ${worktree.baseRef}`,
    'All file reads and writes should happen in this worktree. Do not merge, cherry-pick, push, or copy changes back to the parent workspace unless the caller explicitly asks later.',
    'When you finish, summarize the changes you made and any files the parent should inspect in this worktree.',
  ].join('\n')
}

function formatDefinitionCapabilities(definition: BaseAgentDefinition): string | undefined {
  const parts: string[] = []
  if (definition.model) parts.push(`model: ${definition.model}`)
  if (definition.background) parts.push('background')
  if (definition.isolation) parts.push(`isolation: ${definition.isolation}`)
  if (definition.permissionMode) parts.push(`permission: ${definition.permissionMode}`)
  if (definition.skills && definition.skills.length > 0) parts.push(`skills: ${definition.skills.join(', ')}`)
  if (definition.mcpServers && definition.mcpServers.length > 0) parts.push(`MCP: ${definition.mcpServers.join(', ')}`)
  return parts.length > 0 ? parts.join('; ') : undefined
}

function applyAgentResultBudget(content: string, maxResultSizeChars: number | undefined): string {
  if (maxResultSizeChars === undefined || content.length <= maxResultSizeChars) return content
  return [
    content.slice(0, maxResultSizeChars),
    `[Tool result truncated: exceeded ${maxResultSizeChars} chars; original ${content.length} chars]`,
  ].join('\n\n')
}

function joinPromptParts(parts: Array<string | undefined>): string | undefined {
  const present = parts.filter((part): part is string => Boolean(part?.trim()))
  return present.length > 0 ? present.join('\n\n') : undefined
}

function maxOutputWords(maxOutputTokens: number): number {
  return Math.max(1, Math.floor(maxOutputTokens * 0.75))
}

function createSubAgentToolContext(parent: ToolContext, subAgentId: string, abortSignal: AbortSignal, cwd = parent.cwd): ToolContext {
  return {
    cwd,
    sessionId: subAgentId,
    readFiles: new Set(),
    readFileState: new Map(),
    invokedSkills: new Map(),
    taskState: new Map(),
    abortSignal,
  }
}

function errorCodeFor(error: unknown): 'aborted' | 'execution_failed' {
  return error instanceof Error && error.name === 'AbortError' ? 'aborted' : 'execution_failed'
}

function createAbortError(message: string): Error {
  const error = new Error(message)
  error.name = 'AbortError'
  return error
}
