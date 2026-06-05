import { getToolDisplay, isGroupableTool } from '../../tools/display.js'
import type { TUIDisplayItem } from '../types.js'

export type ToolCallItem = Extract<TUIDisplayItem, { kind: 'tool_call' }>

/**
 * Aggregate a batch of completed tool_call items into a single collapsed-line
 * summary, past-tense and pluralized to match Claude Code's
 * CollapsedReadSearchContent output (e.g. "Read 5 files, searched 3 patterns").
 *
 * The input may contain items that are still running (no result yet) — those
 * contribute a present-tense segment ("Reading 2 files") so the summary reads
 * naturally during in-flight batches.
 */
export function formatToolGroupSummary(toolCalls: ToolCallItem[]): string {
  const anyRunning = toolCalls.some((call) => call.status === 'running' || call.status === 'pending' || call.status === 'approved')

  // Group by userFacingName (e.g. "Read", "Search"). Count each bucket.
  const buckets = new Map<string, { count: number; running: number }>()
  for (const call of toolCalls) {
    const name = getToolDisplayName(call.tool, call.input)
    const bucket = buckets.get(name) ?? { count: 0, running: 0 }
    bucket.count += 1
    if (call.status === 'running' || call.status === 'pending' || call.status === 'approved') {
      bucket.running += 1
    }
    buckets.set(name, bucket)
  }

  const segments: string[] = []
  for (const [name, { count, running }] of buckets) {
    const verb = verbFor(name, running > 0 && anyRunning)
    const noun = nounFor(name, count)
    segments.push(`${verb} ${count} ${noun}`)
  }
  return segments.join(', ')
}

function getToolDisplayName(tool: string, input: unknown): string {
  try {
    const display = getToolDisplay(tool, input)
    return display.name || tool
  } catch {
    return tool
  }
}

function verbFor(userFacingName: string, present: boolean): string {
  // Past-tense default matches Claude Code's "Searched/Read/Listed" style.
  // Present-tense is used while any tool in the batch is still in flight.
  switch (userFacingName) {
    case 'Read':   return present ? 'Reading'   : 'Read'
    case 'Search': return present ? 'Searching' : 'Searched'
    case 'Bash':   return present ? 'Running'   : 'Ran'
    case 'List':   return present ? 'Listing'   : 'Listed'
    case 'Write':  return present ? 'Writing'   : 'Wrote'
    case 'Edit':   return present ? 'Editing'   : 'Edited'
    case 'Delete': return present ? 'Deleting'  : 'Deleted'
    default:       return present ? 'Running'   : 'Ran'
  }
}

function nounFor(userFacingName: string, count: number): string {
  const plural = count !== 1
  switch (userFacingName) {
    case 'Read':   return plural ? 'files'       : 'file'
    case 'Search': return plural ? 'patterns'    : 'pattern'
    case 'Bash':   return plural ? 'commands'    : 'command'
    case 'List':   return plural ? 'directories' : 'directory'
    case 'Write':  return plural ? 'files'       : 'file'
    case 'Edit':   return plural ? 'files'       : 'file'
    case 'Delete': return plural ? 'files'       : 'file'
    default:       return plural ? 'tools'       : 'tool'
  }
}

/**
 * Coalesce consecutive groupable tool_call items into a single tool_group.
 * Non-groupable items (e.g. Bash, Edit, Write) and non-tool_call items break
 * the run and are passed through verbatim.
 */
export function groupConsecutiveSafeToolCalls(items: TUIDisplayItem[]): TUIDisplayItem[] {
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
      run.push(item)
      continue
    }
    flushRun()
    out.push(item)
  }
  flushRun()
  return out
}
