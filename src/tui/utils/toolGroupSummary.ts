import stringWidth from 'string-width'
import { getToolDisplay, isGroupableTool } from '../../tools/display.js'
import type { TUIDisplayItem } from '../types.js'

export type ToolCallItem = Extract<TUIDisplayItem, { kind: 'tool_call' }>

const MAX_VISIBLE_INPUTS = 3
const MAX_INPUT_WIDTH = 30

/** Format a same-tool batch as "Tool (input 1, input 2, input 3, ...)". */
export function formatToolGroupSummary(toolCalls: ToolCallItem[]): string {
  const first = toolCalls[0]
  if (!first) return ''

  const display = getToolDisplay(first.tool, first.input)
  const inputs = toolCalls
    .slice(0, MAX_VISIBLE_INPUTS)
    .map((call) => truncateEndByWidth(getToolDisplay(call.tool, call.input).summary, MAX_INPUT_WIDTH))
    .filter(Boolean)

  if (toolCalls.length > MAX_VISIBLE_INPUTS) inputs.push('...')
  return inputs.length > 0 ? `${display.name} (${inputs.join(', ')})` : display.name
}

/** Summarize current results while keeping failures and pending calls visible. */
export function formatToolGroupResultSummary(toolCalls: ToolCallItem[]): string | undefined {
  const exactSummaries = toolCalls.map((call) =>
    call.status === 'done' ? call.resultDisplay?.summary?.trim() : undefined,
  )
  const firstSummary = exactSummaries[0]
  if (
    firstSummary
    && exactSummaries.length === toolCalls.length
    && exactSummaries.every((summary) => summary === firstSummary)
  ) {
    return firstSummary
  }

  const counts = {
    found: 0,
    succeeded: 0,
    noResult: 0,
    failed: 0,
    denied: 0,
    running: 0,
  }
  for (const call of toolCalls) {
    if (call.status === 'error') counts.failed += 1
    else if (call.status === 'denied') counts.denied += 1
    else if (call.status === 'running' || call.status === 'pending' || call.status === 'approved') counts.running += 1
    else {
      const summary = call.resultDisplay?.summary?.trim() ?? ''
      if (/^Found\b/i.test(summary)) counts.found += 1
      else if (/^No\b/i.test(summary)) counts.noResult += 1
      else counts.succeeded += 1
    }
  }

  const segments: string[] = []
  if (counts.found > 0) segments.push(`${counts.found} found`)
  if (counts.succeeded > 0) segments.push(`${counts.succeeded} succeeded`)
  if (counts.noResult > 0) segments.push(`${counts.noResult} no result`)
  if (counts.failed > 0) segments.push(`${counts.failed} failed`)
  if (counts.denied > 0) segments.push(`${counts.denied} denied`)
  if (counts.running > 0) segments.push(`${counts.running} running`)
  return segments.join(' · ') || undefined
}

/**
 * Coalesce only consecutive calls whose raw tool name and thought segment
 * match. Every non-tool item is a hard boundary, and existing groups are
 * passed through rather than merged again.
 */
export function groupConsecutiveSameToolCalls(items: TUIDisplayItem[]): TUIDisplayItem[] {
  const out: TUIDisplayItem[] = []
  let run: ToolCallItem[] = []

  const flushRun = () => {
    if (run.length === 0) return
    if (run.length === 1) {
      out.push(run[0]!)
    } else {
      out.push({
        kind: 'tool_group',
        id: `tool-group-${run[0]!.toolUseId}`,
        toolCalls: run.slice(),
        createdAt: run[0]!.createdAt,
      })
    }
    run = []
  }

  for (const item of items) {
    if (item.kind === 'tool_call' && isGroupableTool(item.tool)) {
      const previous = run[run.length - 1]
      if (
        previous
        && (previous.tool !== item.tool || previous.groupSegmentId !== item.groupSegmentId)
      ) {
        flushRun()
      }
      run.push(item)
      continue
    }
    flushRun()
    out.push(item)
  }
  flushRun()
  return out
}

function truncateEndByWidth(value: string, maxWidth: number): string {
  if (stringWidth(value) <= maxWidth) return value
  const ellipsis = '...'
  const target = Math.max(0, maxWidth - stringWidth(ellipsis))
  let output = ''
  let width = 0
  for (const segment of [...value]) {
    const segmentWidth = stringWidth(segment)
    if (width + segmentWidth > target) break
    output += segment
    width += segmentWidth
  }
  return `${output}${ellipsis}`
}
