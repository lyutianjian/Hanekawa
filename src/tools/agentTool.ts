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
import { runLifecycleHooks, type Hooks } from '../harness/hooks.js'
import type { ModelProvider, Tool, ToolContext } from '../harness/types.js'

export const ALL_AGENT_DISALLOWED_TOOLS = ['Agent', 'Bash'] as const

const DEFAULT_AGENT_MAX_TURNS = 10
const VERIFICATION_AGENT_MAX_TURNS = 20

const agentTypes = ['general', 'explore', 'plan', 'verification'] as const
export type AgentType = typeof agentTypes[number]

export interface BaseAgentDefinition {
  type: AgentType
  description: string
  tools?: readonly string[]
  disallowedTools: readonly string[]
  maxTurns: number
  omitProjectContext?: boolean
  background?: boolean
  getSystemPrompt(baseSystem?: string): string | undefined
}

const GENERAL_PURPOSE_AGENT: BaseAgentDefinition = {
  type: 'general',
  description: 'General-purpose read-only sub-agent for isolated research tasks.',
  disallowedTools: ALL_AGENT_DISALLOWED_TOOLS,
  maxTurns: DEFAULT_AGENT_MAX_TURNS,
  getSystemPrompt: (baseSystem) => baseSystem,
}

const EXPLORE_AGENT: BaseAgentDefinition = {
  type: 'explore',
  description: 'Fast read-only code exploration agent for broad search, navigation, and codebase questions.',
  tools: ['Glob', 'Grep', 'Read'],
  disallowedTools: ['Agent', 'Bash', 'Write', 'Edit', 'Delete', 'MultiEdit', 'TodoWrite'],
  maxTurns: DEFAULT_AGENT_MAX_TURNS,
  omitProjectContext: true,
  getSystemPrompt: () => `You are a code exploration specialist for Hanekawa.

=== READ-ONLY MODE ===
You are strictly limited to searching and reading existing files. Do not create, edit, move, delete, or copy files. Do not run commands that change project state.

Your job is to quickly map the relevant parts of the codebase:
- Use Glob for broad file discovery.
- Use Grep for content searches and symbol discovery.
- Use Read when you know which file needs inspection.
- Search with multiple naming conventions before concluding something does not exist.
- Prefer parallel read-only searches when they are independent.

Return concise findings with file paths and line numbers when useful. Do not propose edits unless the caller explicitly asked for implementation guidance.`,
}

const PLAN_AGENT: BaseAgentDefinition = {
  type: 'plan',
  description: 'Read-only software planning agent for implementation strategy and trade-off analysis.',
  tools: ['Glob', 'Grep', 'Read'],
  disallowedTools: ['Agent', 'Bash', 'Write', 'Edit', 'Delete', 'MultiEdit', 'TodoWrite'],
  maxTurns: DEFAULT_AGENT_MAX_TURNS,
  omitProjectContext: true,
  getSystemPrompt: () => `You are a software architecture and planning specialist for Hanekawa.

=== READ-ONLY MODE ===
You may explore the repository, but you must not create, edit, move, delete, or copy files. You do not have file editing tools.

Your process:
1. Understand the requested change and any constraints in the caller's prompt.
2. Explore relevant files, existing patterns, and adjacent features.
3. Design an implementation plan that fits the current architecture.
4. Call out meaningful trade-offs, risks, and sequencing.

End with a short "Critical Files" section listing the 3-5 files most important for implementation.`,
}

const VERIFICATION_AGENT: BaseAgentDefinition = {
  type: 'verification',
  description: 'Adversarial verification agent that tries to break an implementation before completion is reported.',
  tools: ['Bash', 'Glob', 'Grep', 'Read'],
  disallowedTools: ['Agent', 'Write', 'Edit', 'Delete', 'MultiEdit', 'TodoWrite'],
  maxTurns: VERIFICATION_AGENT_MAX_TURNS,
  background: true,
  getSystemPrompt: () => `You are a verification specialist. Your job is not to confirm that the implementation works; your job is to try to break it.

=== DO NOT MODIFY THE PROJECT ===
You are strictly prohibited from creating, modifying, deleting, moving, or copying files in the project directory. Do not install packages. Do not run git write operations such as add, commit, push, reset, checkout, restore, or clean.

You may use read-only repository inspection tools. If the Bash tool is available, use it only for verification commands such as status checks, builds, tests, type checks, linters, read-only git commands, or read-only CLI invocations. If a command would write to the project, do not run it.

Verification discipline:
- Reading code is not verification. Exercise the changed behavior when possible.
- Passing tests are context, not proof. Add at least one adversarial probe that fits the change.
- For frontend work, verify the app behavior with an actual runtime or browser tool if available.
- For API or CLI work, run representative inputs and edge cases.
- For bug fixes, reproduce the original failure when possible, then verify the fix.
- If a check cannot run because the environment is missing something, report PARTIAL and say exactly what blocked it.

Every check in your final report must include:
### Check: [what you verified]
**Command run:**
  [exact command or tool action]
**Output observed:**
  [relevant observed output]
**Result: PASS** or **Result: FAIL**

End with exactly one of these lines:
VERDICT: PASS
VERDICT: FAIL
VERDICT: PARTIAL`,
}

export const BUILT_IN_AGENT_DEFINITIONS = [
  GENERAL_PURPOSE_AGENT,
  EXPLORE_AGENT,
  PLAN_AGENT,
  VERIFICATION_AGENT,
] as const

const agentInputSchema = z.object({
  task: z.string().min(1),
  subagent_type: z.enum(agentTypes),
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

export function filterToolsForSubAgent(
  tools: Tool[],
  definition: BaseAgentDefinition = GENERAL_PURPOSE_AGENT,
): Tool[] {
  const allowed = definition.tools ? new Set<string>(definition.tools) : undefined
  const disallowed = new Set<string>(definition.disallowedTools)
  return tools.filter((tool) => {
    if (allowed && !allowed.has(tool.name)) return false
    if (disallowed.has(tool.name)) return false
    return allowed !== undefined ? true : tool.isReadOnly === true
  })
}

export function createAgentTool(options: CreateAgentToolOptions): Tool {
  return {
    name: 'Agent',
    description: [
      'Run a typed sub-agent on an isolated task. Cannot spawn nested agents.',
      'Use subagent_type "general" for ordinary read-only delegation, "explore" for fast code search,',
      '"plan" for read-only implementation planning, and "verification" to adversarially verify completed work.',
    ].join(' '),
    inputSchema: agentInputSchema,
    riskLevel: 'safe',
    async execute(input, context) {
      const parsed = agentInputSchema.parse(input)
      const agentDefinition = getBuiltInAgentDefinition(parsed.subagent_type)
      const subAgentId = randomUUID()
      const recordStream = new MemoryRecordStream()
      const subTools = filterToolsForSubAgent(options.tools(), agentDefinition)
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
          context.abortSignal,
          parsed.subagent_type,
        ),
        'subagentStart',
      )
      const loop = new AgentLoop({
        provider: options.provider,
        model: options.model,
        modelKey: options.modelKey,
        tools: subTools,
        contextBuilder: new ContextBuilder(undefined, options.contextManagement),
        toolRunner,
        toolContext,
        system: buildAgentSystemPrompt(agentDefinition, parsed.systemPrompt, options.system),
        projectContext: agentDefinition.omitProjectContext ? undefined : options.projectContext,
        skills: options.skills,
        promptCacheRetention: options.promptCacheRetention,
        contextManagement: options.contextManagement,
        isGitRepo: options.isGitRepo,
        maxTurns: parsed.maxTurns ?? agentDefinition.maxTurns,
        fallbackModel: options.fallbackModel,
        fallbackRetryDelayMs: options.fallbackRetryDelayMs,
        hooks: options.hooks,
        cacheRuntime: options.cacheRuntime,
        permissionMode: () => permissionGate.getMode(),
        recordStream,
      })

      try {
        const result = await loop.run(parsed.task, context.abortSignal)
        await appendSubagentHookOutput(
          recordStream,
          await runLifecycleHooks(
            options.hooks?.subagentStop,
            'subagentStop',
            {
              agentId: subAgentId,
              agentType: parsed.subagent_type,
              response: result.content,
            },
            toolContext,
            context.abortSignal,
            parsed.subagent_type,
          ),
          'subagentStop',
        )
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

async function appendSubagentHookOutput(
  recordStream: MemoryRecordStream,
  result: Awaited<ReturnType<typeof runLifecycleHooks>>,
  hookName: 'subagentStart' | 'subagentStop',
): Promise<void> {
  const blocks: string[] = []
  if (result.stdout.trim()) blocks.push(result.stdout.trim())
  if (result.failures.length > 0) blocks.push(`Hook failures:\n${result.failures.join('\n')}`)
  if (result.blockingErrors.length > 0) blocks.push(`Hook blocking errors:\n${result.blockingErrors.join('\n')}`)
  if (blocks.length === 0) return

  await recordStream.append({
    id: randomUUID(),
    type: 'message',
    role: 'user',
    content: `<system-reminder>${hookName} hook output:\n${blocks.join('\n\n')}</system-reminder>`,
    createdAt: new Date().toISOString(),
  })
}

function getBuiltInAgentDefinition(type: AgentType): BaseAgentDefinition {
  return BUILT_IN_AGENT_DEFINITIONS.find((definition) => definition.type === type) ?? GENERAL_PURPOSE_AGENT
}

function buildAgentSystemPrompt(
  definition: BaseAgentDefinition,
  overrideSystemPrompt: string | undefined,
  baseSystem: string | undefined,
): string | undefined {
  if (definition.type === 'general') {
    return overrideSystemPrompt ?? definition.getSystemPrompt(baseSystem)
  }

  const parts = [
    definition.getSystemPrompt(baseSystem),
    overrideSystemPrompt ? `# Additional caller instructions\n${overrideSystemPrompt}` : undefined,
  ].filter((part): part is string => Boolean(part?.trim()))

  return parts.length > 0 ? parts.join('\n\n') : undefined
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
