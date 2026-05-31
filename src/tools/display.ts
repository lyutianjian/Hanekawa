import type { Tool } from '../harness/types.js'
import { createSkillTool } from './skillTool.js'
import { getBuiltinTools } from './index.js'

const TOOL_SUMMARY_MAX_LENGTH = 120

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
  const task = typeof input.task === 'string' ? truncateMiddle(input.task.trim(), 100) : undefined
  return {
    name: subagentType ? `${subagentType} agent` : 'Agent',
    summary: [subagentType, task].filter(Boolean).join(': '),
  }
}

function getAgentActivityDescription(input: unknown): string | undefined {
  if (!isRecord(input)) return 'Running agent'
  const subagentType = typeof input.subagent_type === 'string' ? input.subagent_type : undefined
  return subagentType ? `Running ${subagentType} agent` : 'Running agent'
}
