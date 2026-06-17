import type { Tool } from '../harness/types.js'
import { createSkillTool } from './skillTool.js'
import { getBuiltinTools } from './index.js'

const TOOL_SUMMARY_MAX_LENGTH = 120
const AGENT_TITLE_SUMMARY_MAX_LENGTH = 36

let cachedTools: Map<string, Tool> | undefined

function toolsByName(): Map<string, Tool> {
  if (!cachedTools) {
    cachedTools = new Map<string, Tool>()
    for (const tool of [...getBuiltinTools(), createSkillTool()]) {
      cachedTools.set(tool.name, tool)
    }
  }
  return cachedTools
}

export interface ToolDisplay {
  name: string
  summary: string
}

export function getToolDisplay(toolName: string, input: unknown): ToolDisplay {
  if (toolName === 'Agent') return getAgentToolDisplay(input)
  const tool = toolsByName().get(toolName)
  return {
    name: sanitizeDisplayText(tool?.userFacingName?.(input) || toolName, toolName),
    summary: sanitizeDisplayText(tool?.getToolUseSummary?.(input) ?? fallbackSummary(input), ''),
  }
}

export function getToolActivityDescription(toolName: string, input: unknown): string | undefined {
  if (toolName === 'Agent') return getAgentActivityDescription(input)
  const tool = toolsByName().get(toolName)
  return sanitizeDisplayText(tool?.getActivityDescription?.(input), '') || undefined
}

export function shouldDisplayToolResult(toolName: string, input: unknown, result: string | undefined): boolean {
  if (!result) return false
  const tool = toolsByName().get(toolName)
  if (tool?.shouldDisplayResult) return tool.shouldDisplayResult(input, result)
  return false
}

export function getToolResultSummary(
  toolName: string,
  input: unknown,
  result: string | undefined,
  ok: boolean,
): string | null {
  if (!result) return null
  if (toolName === 'Agent') return getAgentResultSummary(input, result, ok)
  const tool = toolsByName().get(toolName)
  if (!tool?.renderToolResultSummary) return null
  try {
    return tool.renderToolResultSummary(input, result, ok)
  } catch {
    return null
  }
}

/**
 * Tools whose results can be collapsed into a parallel-tool group summary line.
 * Bash is excluded despite being concurrency-safe because its output is
 * typically large and benefits from an individual ToolCallBlock.
 */
const GROUPABLE_TOOLS = new Set(['Read', 'Grep', 'Glob'])

export function isGroupableTool(toolName: string): boolean {
  return GROUPABLE_TOOLS.has(toolName)
}

export function filePathSummary(input: unknown): string | null {
  if (!isRecord(input)) return null
  const value = input.filePath ?? input.path
  return typeof value === 'string' && value.trim().length > 0
    ? truncateMiddle(value.trim(), TOOL_SUMMARY_MAX_LENGTH)
    : null
}

export function patternSummary(input: unknown): string | null {
  if (!isRecord(input) || typeof input.pattern !== 'string') return null
  const parts = [`pattern: "${truncateMiddle(input.pattern, 80)}"`]
  if (typeof input.path === 'string' && input.path.trim()) {
    parts.push(`path: "${truncateMiddle(input.path.trim(), 60)}"`)
  }
  if (typeof input.glob === 'string' && input.glob.trim()) {
    parts.push(`glob: "${truncateMiddle(input.glob.trim(), 60)}"`)
  }
  return parts.join(', ')
}

export function commandSummary(input: unknown): string | null {
  if (!isRecord(input) || typeof input.command !== 'string') return null
  const lines = input.command.trim().split(/\r?\n/)
  const firstLines = lines.slice(0, 2).join('\n')
  const suffix = lines.length > 2 ? '...' : ''
  return truncateMiddle(`${firstLines}${suffix}`, TOOL_SUMMARY_MAX_LENGTH)
}

export function truncateMiddle(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value
  const keep = Math.max(1, Math.floor((maxLength - 3) / 2))
  return `${value.slice(0, keep)}...${value.slice(value.length - keep)}`
}

function fallbackSummary(input: unknown): string {
  if (typeof input === 'string') return truncateMiddle(input, TOOL_SUMMARY_MAX_LENGTH)
  if (!isRecord(input)) return ''
  try {
    return truncateMiddle(JSON.stringify(input), TOOL_SUMMARY_MAX_LENGTH)
  } catch {
    return ''
  }
}

function sanitizeDisplayText(value: string | null | undefined, fallback: string): string {
  if (!value) return fallback
  return value.replace(/\s+/g, ' ').trim()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function getAgentToolDisplay(input: unknown): ToolDisplay {
  if (!isRecord(input)) return { name: 'Agent', summary: '' }
  const subagentType = typeof input.subagent_type === 'string' ? input.subagent_type : undefined
  const summary = agentBriefSummary(input)
  return {
    name: subagentType ? `${subagentType} agent` : 'Agent',
    summary: summary ? truncateMiddle(summary, AGENT_TITLE_SUMMARY_MAX_LENGTH) : '',
  }
}

function agentBriefSummary(input: Record<string, unknown>): string | undefined {
  for (const key of ['description', 'name', 'task']) {
    const value = input[key]
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim()
    }
  }
  return undefined
}

function getAgentActivityDescription(input: unknown): string | undefined {
  if (!isRecord(input)) return 'Running agent'
  const subagentType = typeof input.subagent_type === 'string' ? input.subagent_type : undefined
  return subagentType ? `Running ${subagentType} agent` : 'Running agent'
}

function getAgentResultSummary(_input: unknown, _result: string, ok: boolean): string | null {
  // The Agent tool sets metadata.display.summary directly at execute() time
  // with full stats ("Done (N tool uses · Xk tokens · Ys)"). For older
  // sessions that predate that field, show a generic "Done" so the collapsed
  // line doesn't dump the agent's entire transcript.
  if (!ok) return null
  return 'Done'
}

function formatTokenCount(n: number): string {
  if (n < 1000) return String(n)
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`
  return `${Math.round(n / 1000)}k`
}

export { formatTokenCount }
