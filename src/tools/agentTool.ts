import { randomUUID } from 'node:crypto'
import { z } from 'zod/v3'
import { agentCacheSource, resetCacheBreakDetection } from '../harness/cacheBreakDetection.js'
import { ContextBuilder } from '../harness/contextBuilder.js'
import { AgentLoop, type ActiveModelRuntime } from '../harness/loop.js'
import { PermissionGate, type PermissionMode, type PermissionPrompt } from '../harness/permissions.js'
import { MemoryRecordStream } from '../harness/recordStream.js'
import { ToolRunner } from '../harness/toolRunner.js'
import type { ContextManagementConfig } from '../prompts/budget.js'
import type { SkillDefinition } from '../services/skills/skillsService.js'
import type { CacheRuntime } from '../harness/cacheControl.js'
import type { Hooks } from '../harness/hooks.js'
import type { ModelProvider, Tool, ToolContext } from '../harness/types.js'

export const ALL_AGENT_DISALLOWED_TOOLS = ['Agent', 'bash'] as const

const DEFAULT_AGENT_MAX_TURNS = 10

const agentInputSchema = z.object({
  task: z.string().min(1),
  systemPrompt: z.string().optional(),
  maxTurns: z.number().int().min(1).optional(),
}).strict()

export interface CreateAgentToolOptions {
  provider: ModelProvider
  model: string
  modelKey?: string
  providerName?: string
  promptCacheRetention?: 'in_memory' | '24h'
  fallbackModel?: ActiveModelRuntime
  fallbackRetryDelayMs?: number
  tools(): Tool[]
  permissionPrompt: PermissionPrompt
  permissionMode?(): PermissionMode
  cwd: string
  system?: string
  projectContext?: string
  skills?: SkillDefinition[]
  contextManagement?: Partial<ContextManagementConfig>
  isGitRepo?: boolean
  hooks?: Hooks
  cacheRuntime?: CacheRuntime
}

export function filterToolsForSubAgent(tools: Tool[]): Tool[] {
  const disallowed = new Set<string>(ALL_AGENT_DISALLOWED_TOOLS)
  return tools.filter((tool) => tool.isReadOnly === true && !disallowed.has(tool.name))
}

export function createAgentTool(options: CreateAgentToolOptions): Tool {
  return {
    name: 'Agent',
    description: 'Run a sub-agent on an isolated task. Cannot spawn nested agents.',
    inputSchema: agentInputSchema,
    riskLevel: 'safe',
    async execute(input, context) {
      const parsed = agentInputSchema.parse(input)
      const subAgentId = randomUUID()
      const recordStream = new MemoryRecordStream()
      const subTools = filterToolsForSubAgent(options.tools())
      const permissionGate = new PermissionGate(options.permissionPrompt, undefined, {
        mode: options.permissionMode?.(),
      })
      const toolRunner = new ToolRunner(subTools, permissionGate, {
        onRecord: async (record) => {
          await recordStream.append(record)
        },
      }, {
        preToolUse: options.hooks?.preToolUse,
      })
      const toolContext = createSubAgentToolContext(context, subAgentId)
      const loop = new AgentLoop({
        provider: options.provider,
        model: options.model,
        modelKey: options.modelKey,
        tools: subTools,
        contextBuilder: new ContextBuilder(undefined, options.contextManagement),
        toolRunner,
        toolContext,
        system: parsed.systemPrompt ?? options.system,
        projectContext: options.projectContext,
        skills: options.skills,
        promptCacheRetention: options.promptCacheRetention,
        contextManagement: options.contextManagement,
        isGitRepo: options.isGitRepo,
        maxTurns: parsed.maxTurns ?? DEFAULT_AGENT_MAX_TURNS,
        fallbackModel: options.fallbackModel,
        fallbackRetryDelayMs: options.fallbackRetryDelayMs,
        hooks: options.hooks,
        cacheRuntime: options.cacheRuntime,
        permissionMode: () => permissionGate.getMode(),
        recordStream,
      })

      try {
        const result = await loop.run(parsed.task, context.abortSignal)
        return { ok: true, content: result.content }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return { ok: false, content: `Sub-agent failed: ${message}`, errorCode: errorCodeFor(error) }
      } finally {
        resetCacheBreakDetection(agentCacheSource(subAgentId))
      }
    },
  }
}

function createSubAgentToolContext(parent: ToolContext, subAgentId: string): ToolContext {
  return {
    cwd: parent.cwd,
    sessionId: subAgentId,
    readFiles: new Set(),
    readFileState: new Map(),
    invokedSkills: new Map(),
    taskState: new Map(),
    abortSignal: parent.abortSignal,
  }
}

function errorCodeFor(error: unknown): 'aborted' | 'execution_failed' {
  return error instanceof Error && error.name === 'AbortError' ? 'aborted' : 'execution_failed'
}
