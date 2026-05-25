import { randomUUID } from 'node:crypto'
import { z } from 'zod/v3'
import { agentCacheSource, resetCacheBreakDetection } from '../harness/cacheBreakDetection.js'
import { ContextBuilder } from '../harness/contextBuilder.js'
import { AgentLoop, type ActiveModelRuntime } from '../harness/loop.js'
import {
  PermissionGate,
  type DenialStateStore,
  type PermissionMode,
  type PermissionPrompt,
  type PermissionRule,
} from '../harness/permissions.js'
import { MemoryRecordStream } from '../harness/recordStream.js'
import { ToolRunner } from '../harness/toolRunner.js'
import type { ContextManagementConfig } from '../prompts/budget.js'
import type { SkillDefinition } from '../services/skills/skillsService.js'
import type { CacheRuntime } from '../harness/cacheControl.js'
import { runLifecycleHooks, type Hooks } from '../harness/hooks.js'
import type { ModelProvider, Tool, ToolContext } from '../harness/types.js'

export const NESTED_AGENT_FORBIDDEN_TOOLS = ['Agent'] as const

export const WRITE_LIKE_AGENT_TOOL_NAMES = new Set([
  'Bash',
  'Write',
  'Edit',
  'MultiEdit',
  'Delete',
  'NotebookEdit',
])

export const DEFAULT_AGENT_MAX_TURNS = 10
const VERIFICATION_AGENT_MAX_TURNS = 20
export const AGENT_MAX_RESULT_SIZE_CHARS = 32_000

const agentTypes = ['general', 'explore', 'plan', 'verification'] as const
export type AgentType = typeof agentTypes[number]

export interface BaseAgentDefinition {
  type: string
  description: string
  tools?: readonly string[]
  disallowedTools: readonly string[]
  maxTurns: number
  maxResultSizeChars?: number
  isReadOnlyAgent: boolean
  omitProjectContext?: boolean
  criticalSystemReminder?: string
  getSystemPrompt(baseSystem?: string): string | undefined
}

const VERIFICATION_AGENT_CRITICAL_REMINDER = `# Critical Verification Reminder
You are still the verification specialist. Stay adversarial, do not modify the project, run or cite concrete verification evidence where possible, and end with exactly one VERDICT line.`

const GENERAL_PURPOSE_AGENT: BaseAgentDefinition = {
  type: 'general',
  description: 'General-purpose read-only sub-agent for isolated research tasks.',
  disallowedTools: NESTED_AGENT_FORBIDDEN_TOOLS,
  maxTurns: DEFAULT_AGENT_MAX_TURNS,
  maxResultSizeChars: AGENT_MAX_RESULT_SIZE_CHARS,
  isReadOnlyAgent: true,
  getSystemPrompt: (baseSystem) => baseSystem,
}

const EXPLORE_AGENT: BaseAgentDefinition = {
  type: 'explore',
  description: 'Fast read-only code exploration agent for broad search, navigation, and codebase questions.',
  tools: ['Glob', 'Grep', 'Read'],
  disallowedTools: ['Agent', 'Bash', 'Write', 'Edit', 'Delete', 'MultiEdit', 'TodoWrite'],
  maxTurns: DEFAULT_AGENT_MAX_TURNS,
  maxResultSizeChars: AGENT_MAX_RESULT_SIZE_CHARS,
  isReadOnlyAgent: true,
  omitProjectContext: true,
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
  disallowedTools: ['Agent', 'Bash', 'Write', 'Edit', 'Delete', 'MultiEdit', 'TodoWrite'],
  maxTurns: DEFAULT_AGENT_MAX_TURNS,
  maxResultSizeChars: AGENT_MAX_RESULT_SIZE_CHARS,
  isReadOnlyAgent: true,
  omitProjectContext: true,
  getSystemPrompt: () => `You are a software architecture and planning specialist for Hanekawa.

=== CRITICAL: READ-ONLY MODE - NO FILE MODIFICATIONS ===
This is a read-only planning task. You are strictly prohibited from:
- Creating new files.
- Modifying existing files.
- Deleting files.
- Moving or copying files.
- Running any command or tool action that changes project state.

Your role is exclusively to explore the codebase and design implementation plans. You only have Glob, Grep, and Read, so attempting to edit files or run shell commands will fail.

You will be given requirements and, sometimes, a suggested perspective. Apply the caller's constraints throughout the design.

## Your Process

1. Understand Requirements: identify the requested outcome, constraints, success criteria, and what is in or out of scope.
2. Explore Thoroughly: read any files named by the caller, find existing patterns with Glob/Grep/Read, trace relevant code paths, and identify similar features as references.
3. Design Solution: fit the plan to the current architecture, reuse local conventions, and call out meaningful trade-offs or risks.
4. Detail the Plan: provide implementation sequencing, affected interfaces, edge cases, and focused tests.

Do not invent implementation details the repository does not support. When there are multiple plausible approaches, recommend one and explain the trade-off briefly.

Keep your final report concise - under ~500 words.

End with exactly this section:

### Critical Files for Implementation
List the 3-5 files most important for implementation.`,
}

const VERIFICATION_AGENT: BaseAgentDefinition = {
  type: 'verification',
  description: 'Adversarial verification agent that tries to break an implementation before completion is reported.',
  tools: ['Bash', 'Glob', 'Grep', 'Read'],
  disallowedTools: ['Agent', 'Write', 'Edit', 'Delete', 'MultiEdit', 'TodoWrite'],
  maxTurns: VERIFICATION_AGENT_MAX_TURNS,
  maxResultSizeChars: AGENT_MAX_RESULT_SIZE_CHARS,
  isReadOnlyAgent: false,
  criticalSystemReminder: VERIFICATION_AGENT_CRITICAL_REMINDER,
  getSystemPrompt: () => `You are a verification specialist. Your job is not to confirm that the implementation works; your job is to try to break it.

Your default failure mode as an LLM is overconfidence. Treat that as a real bug in your own process.

Two named traps:
- verification avoidance: reading code, nodding along, and reporting PASS without executing anything meaningful.
- being seduced by the first 80%: a UI, CLI, or API looks polished on the happy path, so you miss dead buttons, broken edge cases, partial state, or unusable workflows.

=== DO NOT MODIFY THE PROJECT ===
You are strictly prohibited from creating, modifying, deleting, moving, or copying files in the project directory. Do not install packages. Do not run git write operations such as add, commit, push, reset, checkout, restore, or clean.

You may use read-only repository inspection tools. If the Bash tool is available, use it only for verification commands such as status checks, builds, tests, type checks, linters, read-only git commands, or read-only CLI invocations. If a command would write to the project, do not run it.

=== RECOGNIZE YOUR OWN RATIONALIZATIONS ===
When you notice one of these thoughts, do the corrective action instead:
- "The code looks correct based on reading." Reading is not verification. Run the behavior or a focused check.
- "The implementer's tests passed." The implementer is also an LLM. Independently verify; do not trust another agent's claim.
- "This should work." "Should" is not evidence. Convert it into an observed result.
- "I'll start the server and inspect code." If you start a server, hit the endpoint or workflow with a real request/action.
- "I do not have a browser." First check whether browser MCP tools or other runtime/browser tools are available. If a browser tool fails, debug the server, URL, selector, or environment before declaring it impossible.
- "This is too time-consuming." That is not your decision. Run the highest-signal checks that fit the task and report exact limits if blocked.
- "The change is small, so a smoke test is enough." Small changes can break integration points. Probe at least one edge or failure path.
- "I am not sure whether this is a bug, so PARTIAL." PARTIAL is only for environmental inability to verify, not uncertainty about severity.

=== VERIFICATION DISCIPLINE ===
- Exercise the changed behavior when possible.
- Passing tests are context, not proof.
- Prefer commands that directly hit the changed surface over broad, indirect confidence checks.
- For frontend work, verify actual runtime behavior with browser/runtime tools if available, not just screenshots or code reading.
- For API or CLI work, run representative inputs and edge cases.
- For bug fixes, reproduce the original failure when possible, then verify the fix.
- Include at least one adversarial probe that fits the change: concurrency, boundary values, idempotency, partial failure/orphaned state, malformed input, permission denial, missing config, or restart/resume behavior.
- If a check cannot run because the environment is missing something, report PARTIAL and say exactly what blocked it.

=== BEFORE REPORTING FAIL ===
For every suspected failure, quickly rule out:
- Already handled: is this checked or normalized elsewhere?
- Intentional: is this behavior a documented or obvious design choice?
- Not actionable: is this outside the requested change or current verification scope?

If those are ruled out and the issue is real, report FAIL.

=== OUTPUT FORMAT ===
Keep your final report concise - under ~800 words.

Every verification check in your final report must include:
### Check: [what you verified]
**Command run:**
  [exact command or tool action]
**Output observed:**
  [relevant observed output]
**Result: PASS** or **Result: FAIL**

Checks without a Command run block are skipped, not passed.

End with exactly one of these lines:
VERDICT: PASS
VERDICT: FAIL
VERDICT: PARTIAL

Use PASS only when the meaningful checks passed. Use FAIL when you found an actionable defect. Use PARTIAL only when environmental limits prevented enough verification; name the missing tool, dependency, service, credential, or runtime condition.`,
}

export const BUILT_IN_AGENT_DEFINITIONS = [
  GENERAL_PURPOSE_AGENT,
  EXPLORE_AGENT,
  PLAN_AGENT,
  VERIFICATION_AGENT,
] as const

const agentInputSchema = z.object({
  task: z.string().min(1),
  subagent_type: z.string().min(1),
  systemPrompt: z.string().optional(),
  maxTurns: z.number().int().min(1).optional(),
  maxOutputTokens: z.number().int().min(1).optional(),
}).strict()

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
  cwd: string
  system?: string
  projectContext?: string
  skills?: SkillDefinition[]
  agentDefinitions?: BaseAgentDefinition[]
  contextManagement?: Partial<ContextManagementConfig>
  isGitRepo?: boolean
  hooks?: Hooks
  cacheRuntime?: CacheRuntime
  getCompactFailureCount?(): Promise<number>
  setCompactFailureCount?(count: number): Promise<void>
}

export function filterToolsForSubAgent(
  tools: Tool[],
  definition: BaseAgentDefinition = GENERAL_PURPOSE_AGENT,
): Tool[] {
  const allowed = definition.tools ? new Set<string>(definition.tools) : undefined
  const disallowed = new Set<string>(definition.disallowedTools)
  return tools.filter((tool) => {
    if (allowed && !allowed.has(tool.name)) return false
    if (!allowed && isUnsafeForReadOnlySubAgent(tool)) return false
    if (disallowed.has(tool.name)) return false
    return allowed !== undefined ? true : tool.isReadOnly === true
  })
}

export function infersReadOnlyAgentFromTools(tools: readonly string[] | undefined): boolean {
  return tools === undefined || !tools.some((tool) => WRITE_LIKE_AGENT_TOOL_NAMES.has(tool))
}

function isUnsafeForReadOnlySubAgent(tool: Tool): boolean {
  return tool.isDestructive === true || tool.riskLevel === 'dangerous'
}

export function createAgentTool(options: CreateAgentToolOptions): Tool {
  const agentDefinitions = Object.freeze([...(options.agentDefinitions ?? BUILT_IN_AGENT_DEFINITIONS)])
  return {
    name: 'Agent',
    description: buildAgentToolDescription(agentDefinitions),
    inputSchema: agentInputSchema,
    riskLevel: 'safe',
    maxResultSizeChars: undefined,
    isConcurrencySafeInput(input) {
      const parsed = agentInputSchema.safeParse(input)
      if (!parsed.success) return false
      return getAgentDefinition(agentDefinitions, parsed.data.subagent_type)?.isReadOnlyAgent === true
    },
    async execute(input, context) {
      const parsed = agentInputSchema.parse(input)
      let subAgentId: string | undefined
      const abortController = new AbortController()
      const forwardParentAbort = () => abortController.abort(context.abortSignal?.reason)
      if (context.abortSignal?.aborted) {
        forwardParentAbort()
      } else {
        context.abortSignal?.addEventListener('abort', forwardParentAbort, { once: true })
      }

      try {
        const agentDefinition = getAgentDefinition(agentDefinitions, parsed.subagent_type)
        if (!agentDefinition) {
          throw new Error(`Unknown subagent_type "${parsed.subagent_type}". Available types: ${formatAgentTypes(agentDefinitions)}.`)
        }
        subAgentId = randomUUID()
        const recordStream = new MemoryRecordStream()
        const subTools = filterToolsForSubAgent(options.tools(), agentDefinition)
        const permissionGate = new PermissionGate(options.permissionPrompt, options.getConfigRules?.(), {
          mode: options.permissionMode?.(),
          denialStateStore: options.denialStateStore,
        })
        permissionGate.addSessionRules(options.getSessionRules?.() ?? [])
        const toolRunner = new ToolRunner(subTools, permissionGate, {
          onRecord: async (record) => {
            await recordStream.append(record)
          },
        }, {
          preToolUse: options.hooks?.preToolUse,
        })
        const toolContext = createSubAgentToolContext(context, subAgentId, abortController.signal)
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
        const loop = new AgentLoop({
          provider: options.provider,
          model: options.model,
          modelKey: options.modelKey,
          tools: subTools,
          contextBuilder: new ContextBuilder(undefined, options.contextManagement),
          toolRunner,
          toolContext,
          system: buildAgentSystemPrompt(agentDefinition, parsed.systemPrompt, options.system, parsed.maxOutputTokens),
          criticalSystemReminder: agentDefinition.criticalSystemReminder,
          projectContext: agentDefinition.omitProjectContext ? undefined : options.projectContext,
          skills: options.skills,
          promptCacheRetention: options.promptCacheRetention,
          contextManagement: options.contextManagement,
          isGitRepo: options.isGitRepo,
          maxTurns: parsed.maxTurns ?? agentDefinition.maxTurns,
          maxOutputTokens: parsed.maxOutputTokens,
          fallbackModel: options.fallbackModel,
          compactModel: options.compactModel,
          fallbackRetryDelayMs: options.fallbackRetryDelayMs,
          hooks: options.hooks,
          cacheRuntime: options.cacheRuntime,
          permissionMode: () => permissionGate.getMode(),
          getCompactFailureCount: options.getCompactFailureCount,
          setCompactFailureCount: options.setCompactFailureCount,
          recordStream,
        })
        const result = await loop.run(parsed.task, abortController.signal)
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
        const truncatedContent = applyAgentResultBudget(result.content, agentDefinition.maxResultSizeChars)
        const content = appendHookOutputToToolResult(truncatedContent, stopHookOutput)
        return {
          ok: true,
          content,
          metadata: {
            subagent: {
              type: parsed.subagent_type,
              agentId: subAgentId,
              usage: result.usage,
              verdict: extractVerdict(result.content),
              criticalFiles: extractCriticalFiles(result.content),
            },
          },
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return { ok: false, content: `Sub-agent failed: ${message}`, errorCode: errorCodeFor(error) }
      } finally {
        context.abortSignal?.removeEventListener('abort', forwardParentAbort)
        if (subAgentId) resetCacheBreakDetection(agentCacheSource(subAgentId))
      }
    },
  }
}

async function appendSubagentHookOutput(
  recordStream: MemoryRecordStream,
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

    const candidate = extractCriticalFileCandidate(trimmed)
    if (candidate) files.push(candidate)
    if (files.length >= 5) break
  }

  return files
}

function extractCriticalFileCandidate(trimmed: string): string | undefined {
  // Strip common list markers (- * + or "1." / "1)") before considering the line as a path candidate.
  const withoutMarker = trimmed
    .replace(/^[-*+]\s+/, '')
    .replace(/^\d+[.)]\s+/, '')
    .trim()

  // Prefer the first inline-code span when present, e.g. "- `src/foo.ts` - reason".
  const inlineCode = /^`([^`]+)`/.exec(withoutMarker)
  if (inlineCode) {
    const candidate = inlineCode[1]?.trim()
    return candidate && looksLikePath(candidate) ? candidate : undefined
  }

  // Otherwise accept the leading whitespace-free token (optionally "path:line"),
  // but only when the original line lacks descriptive prose (so we don't fold
  // free-form notes into critical files).
  const match = /^(\S+(?::\d+)?)(?:\s+.*)?$/.exec(withoutMarker)
  const candidate = match?.[1]?.trim()
  if (!candidate || !looksLikePath(candidate)) return undefined

  // If the line continued past the path with prose, only keep the path itself.
  return candidate
}

function looksLikePath(value: string): boolean {
  if (!/[\\/.]/.test(value)) return false
  if (/\s/.test(value)) return false
  return true
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
): string | undefined {
  const outputLimitPrompt = maxOutputTokens === undefined
    ? undefined
    : `Keep your final report under approximately ${maxOutputWords(maxOutputTokens)} words.`

  if (definition.type === 'general') {
    const generalPrompt = overrideSystemPrompt ?? definition.getSystemPrompt(baseSystem)
    return joinPromptParts([generalPrompt, outputLimitPrompt])
  }

  const parts = [
    definition.getSystemPrompt(baseSystem),
    overrideSystemPrompt ? `# Additional caller instructions\n${overrideSystemPrompt}` : undefined,
    outputLimitPrompt,
  ]

  return joinPromptParts(parts)
}

function buildAgentToolDescription(definitions: readonly BaseAgentDefinition[]): string {
  const typeDescriptions = definitions
    .map((definition) => `"${definition.type}" (${definition.description})`)
    .join(', ')
  return [
    'Run a typed sub-agent on an isolated task. Use this for complex, multi-step research, exploration, planning, or verification work whose intermediate tool output does not need to stay in the main context. Cannot spawn nested agents.',
    `Available subagent_type values: ${typeDescriptions}.`,
    'Always pass an explicit subagent_type.',
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

function createSubAgentToolContext(parent: ToolContext, subAgentId: string, abortSignal: AbortSignal): ToolContext {
  return {
    cwd: parent.cwd,
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
