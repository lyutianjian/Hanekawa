/**
 * The side panel's 「子代理」 tab, as data: every `Agent` call in a transcript,
 * flattened into what a list row and a detail page draw.
 *
 * DOM-free like the rest of `model/`.
 */

import { splitAgentReply } from './agentReply.js'
import { toolStepStatus, type SubagentLive, type ToolStepStatus, type TranscriptItem } from './transcript.js'

export const AGENT_TOOL = 'Agent'

export interface SubagentEntry {
  /** The `Agent` call's tool-use id — the same id its transcript step carries. */
  readonly id: string
  readonly name: string
  readonly agentType?: string
  /** What the parent called the job — the call's own summary line. */
  readonly description: string
  readonly status: ToolStepStatus
  readonly model?: string
  readonly toolCount?: number
  /** While running: the tool it started last. */
  readonly live?: SubagentLive
  /** Epoch ms, for a running clock. */
  readonly startedAt?: number
  readonly durationMs?: number
  readonly task?: string
  readonly reply?: string
  readonly notes: readonly string[]
}

/** Running ones first in the order they started, then the finished, newest first. */
export function subagentEntries(items: readonly TranscriptItem[]): SubagentEntry[] {
  const running: SubagentEntry[] = []
  const settled: SubagentEntry[] = []
  for (const item of items) {
    if (item.kind !== 'tool' || item.toolName !== AGENT_TOOL || item.tool === undefined) continue
    const entry = toEntry(item)
    if (entry.status === 'running' || entry.status === 'awaiting-approval') running.push(entry)
    else settled.unshift(entry)
  }
  return [...running, ...settled]
}

function toEntry(item: TranscriptItem): SubagentEntry {
  const tool = item.tool!
  const status = toolStepStatus(item)
  const reply = tool.content === undefined ? undefined : splitAgentReply(tool.content)
  const startedAt = tool.startedAt === undefined ? Number.NaN : Date.parse(tool.startedAt)
  const toolCount = tool.subagent?.toolUseCount ?? tool.live?.toolCount
  const response = fullerReply(reply?.text, tool.subagent?.summary)
  return {
    id: item.id,
    name: tool.displayName,
    description: tool.useSummary,
    status,
    notes: reply?.notes ?? [],
    ...(tool.agentType === undefined ? {} : { agentType: tool.agentType }),
    ...(tool.subagent?.model === undefined ? {} : { model: tool.subagent.model }),
    ...(toolCount === undefined ? {} : { toolCount }),
    ...(status === 'running' && tool.live !== undefined ? { live: tool.live } : {}),
    ...(Number.isFinite(startedAt) ? { startedAt } : {}),
    ...(tool.durationMs === undefined ? {} : { durationMs: tool.durationMs }),
    ...(tool.task === undefined ? {} : { task: tool.task }),
    ...(response === undefined ? {} : { reply: response }),
  }
}

/**
 * The fuller of the result's `content` and the run's own transcript: the same
 * report budgeted differently, and a background agent's result is only a start
 * notice, so the longer text is the truer reply.
 */
function fullerReply(content: string | undefined, summary: string | undefined): string | undefined {
  if (content === undefined || content.length === 0) return summary
  if (summary === undefined || summary.length === 0) return content
  return content.length >= summary.length ? content : summary
}
