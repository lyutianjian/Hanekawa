import type { SessionRecord } from '../harness/types.js'
import type { CommandDefinition, CommandSubagentCleanupResult, CommandSubagentDetails } from './types.js'

export const agentsCommand: CommandDefinition = {
  name: 'agents',
  description: 'Manage custom agent definitions and subagent tasks',
  argumentHint: 'reload|list|show <id>|cleanup [--apply]',
  async run(args, context) {
    const parts = args.trim().split(/\s+/).filter(Boolean)
    const subcommand = parts[0] ?? ''

    if (subcommand === 'reload') {
      if (!context.reloadAgentDefinitions) {
        context.writeLine('Agent definition reload is not available.')
        return
      }

      const count = await context.reloadAgentDefinitions()
      context.writeLine(`Reloaded ${count} custom agent definition${count === 1 ? '' : 's'}.`)
      return
    }

    if (subcommand === 'list') {
      if (!context.listSubagentTasks) {
        context.writeLine('Subagent task list is not available.')
        return
      }

      const tasks = await context.listSubagentTasks()
      context.writeLine(formatTaskList(tasks))
      return
    }

    if (subcommand === 'show') {
      const id = parts[1]
      if (!id) {
        context.writeLine('Usage: /agents show <agentId>')
        return
      }
      if (!context.getSubagentDetails) {
        context.writeLine('Subagent details are not available.')
        return
      }

      const details = await context.getSubagentDetails(id)
      context.writeLine(details ? formatDetails(details) : `No subagent found for ${id}.`)
      return
    }

    if (subcommand === 'cleanup') {
      if (!context.cleanupSubagentWorktrees) {
        context.writeLine('Subagent worktree cleanup is not available.')
        return
      }

      const apply = parts.includes('--apply')
      const result = await context.cleanupSubagentWorktrees({ apply })
      context.writeLine(formatCleanup(result))
      return
    }

    context.writeLine('Usage: /agents reload|list|show <agentId>|cleanup [--apply]')
  },
}

type SubagentTaskRecord = Extract<SessionRecord, { type: 'subagent_task' }>

function formatTaskList(tasks: SubagentTaskRecord[]): string {
  if (tasks.length === 0) return 'No subagent tasks.'

  const sorted = [...tasks].sort((a, b) => {
    const rank = statusRank(a.status) - statusRank(b.status)
    if (rank !== 0) return rank
    return Date.parse(b.createdAt) - Date.parse(a.createdAt)
  })

  const rows = sorted.map((task) => {
    const id = task.agentId.slice(0, 8)
    const agent = task.name && task.name !== task.subagentType
      ? `${task.name}(${task.subagentType})`
      : task.subagentType
    return [
      pad(task.status, 11),
      pad(truncate(agent, 20), 20),
      pad(formatAge(task.createdAt), 8),
      pad(truncate(task.summary ?? task.description, 42), 42),
      id,
    ].join('  ')
  })

  return [
    'status       agent                 age       summary                                     id',
    ...rows,
  ].join('\n')
}

function formatDetails(details: CommandSubagentDetails): string {
  const task = details.task
  const transcript = details.transcript
  const source = task ?? transcript
  if (!source) return 'No subagent details.'

  const lines = [
    `agent: ${source.subagentType} #${source.agentId.slice(0, 8)}`,
  ]

  if (task) {
    lines.push(`status: ${task.status}`)
    lines.push(`task: ${truncate(task.task, 240)}`)
    lines.push(`description: ${truncate(task.description, 160)}`)
    if (task.summary) lines.push(`summary: ${truncate(task.summary, 240)}`)
    if (task.error) lines.push(`error: ${task.error}`)
    if (task.usage) lines.push(`usage: ${formatUsage(task.usage)}`)
    if (task.verdict) lines.push(`verdict: ${task.verdict}`)
    if (task.criticalFiles?.length) lines.push(`critical files: ${task.criticalFiles.join(', ')}`)
    if (task.worktreePath) lines.push(`worktree: ${task.worktreePath}`)
    if (task.worktreeBaseRef) lines.push(`base ref: ${task.worktreeBaseRef}`)
    if (task.worktreeChangeSummary) lines.push(`changes:\n${task.worktreeChangeSummary}`)
  }

  if (transcript) {
    if (transcript.transcriptPath) lines.push(`transcript: ${transcript.transcriptPath}`)
    if (!task?.usage) lines.push(`usage: ${formatUsage(transcript.usage)}`)
    if (!task?.verdict && transcript.verdict) lines.push(`verdict: ${transcript.verdict}`)
    if (!task?.criticalFiles?.length && transcript.criticalFiles?.length) {
      lines.push(`critical files: ${transcript.criticalFiles.join(', ')}`)
    }
    if (!task?.worktreePath && transcript.worktreePath) lines.push(`worktree: ${transcript.worktreePath}`)
    if (!task?.worktreeChangeSummary && transcript.worktreeChangeSummary) {
      lines.push(`changes:\n${transcript.worktreeChangeSummary}`)
    }
  }

  lines.push(`records: ${details.transcriptRecords.length}`)
  return lines.join('\n')
}

function formatCleanup(result: CommandSubagentCleanupResult): string {
  if (result.entries.length === 0) {
    return result.dryRun
      ? 'No completed subagent worktrees to clean. Use /agents cleanup --apply to remove.'
      : 'No completed subagent worktrees to clean.'
  }

  const header = result.dryRun
    ? 'Subagent worktrees (dry-run):'
    : 'Subagent worktree cleanup:'
  const rows = result.entries.map((entry) => {
    const status = entry.error
      ? `error: ${entry.error}`
      : result.dryRun
        ? (entry.exists ? 'would remove' : 'missing')
        : (entry.removed ? 'removed' : 'missing')
    return `${entry.agentId.slice(0, 8)} ${entry.status} ${status} ${entry.worktreePath}`
  })
  const hint = result.dryRun ? 'Run /agents cleanup --apply to remove listed worktrees.' : undefined
  return [header, ...rows, hint].filter((line): line is string => Boolean(line)).join('\n')
}

function statusRank(status: string): number {
  switch (status) {
    case 'running':
      return 0
    case 'failed':
      return 1
    case 'cancelled':
    case 'interrupted':
      return 2
    case 'completed':
      return 3
    default:
      return 4
  }
}

function formatAge(createdAt: string): string {
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(createdAt)) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

function formatUsage(usage: { inputTokens: number; cacheReadInputTokens: number; outputTokens: number }): string {
  return `in ${usage.inputTokens}, cache ${usage.cacheReadInputTokens}, out ${usage.outputTokens}`
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : `${value}${' '.repeat(width - value.length)}`
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value
  return `${value.slice(0, Math.max(0, maxLength - 3))}...`
}
