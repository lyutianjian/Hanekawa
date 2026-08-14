import type { ToolProgressEvent } from '../harness/types.js'
import { getToolActivityDescription } from '../tools/display.js'

/**
 * Spinner sub-text for the set of tool calls currently in flight.
 * Pure formatting; the caller owns the live set.
 */
export function formatToolProgress(events: ToolProgressEvent[]): string | undefined {
  if (events.length === 0) return undefined
  if (events.length === 1) {
    const event = events[0]
    if (!event) return undefined
    return formatSingleToolProgress(event)
  }

  const counts = new Map<string, number>()
  for (const event of events) {
    const name = formatScopedToolName(event)
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }

  if (counts.size === 1) {
    const first = events[0]
    const name = formatScopedToolName(first)
    if (first?.call.name === 'Read') return `Reading ${events.length} files in parallel...`
    return `Running ${events.length} ${name} calls in parallel...`
  }

  return `Running ${events.length} tools in parallel...`
}

export function formatSingleToolProgress(event: ToolProgressEvent): string {
  const details = getToolActivityDescription(event.call.name, event.call.input) ?? formatToolProgressDetails(event.call.input)
  if (details && event.source?.type === 'subagent') {
    return `${formatScopedToolName(event)}: ${details}`
  }
  if (details) return details
  return `Running ${formatScopedToolName(event)}`
}

export function formatSubagentSpinnerProgress(events: ToolProgressEvent[]): string | undefined {
  if (events.length === 0) return undefined

  const agentIds = new Set<string>()
  for (const event of events) {
    agentIds.add(event.source?.agentId ?? `${event.source?.agentType ?? 'agent'}:${event.call.id}`)
  }

  if (agentIds.size > 1) {
    return `${agentIds.size} agents running`
  }

  return formatToolProgress(events)
}

export function formatScopedToolName(event: ToolProgressEvent | undefined): string {
  const name = event?.call.name ?? 'tool'
  if (event?.source?.type === 'subagent') {
    return `${event.source.agentType} > ${name}`
  }
  return name
}

export function formatToolProgressDetails(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined
  const values = input as Record<string, unknown>
  const candidate = values.command ?? values.filePath ?? values.path ?? values.pattern ?? values.query
  return typeof candidate === 'string' && candidate.trim().length > 0
    ? truncateMiddle(candidate.trim(), 80)
    : undefined
}

export function truncateMiddle(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value
  const keep = Math.max(1, Math.floor((maxLength - 3) / 2))
  return `${value.slice(0, keep)}...${value.slice(value.length - keep)}`
}
