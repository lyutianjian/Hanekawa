import { countTextTokens } from '../../prompts/budget.js'
import { sanitizeReportText } from '../../utils/reportSanitizer.js'
import { applyLifecycle, type LifecycleSettings } from './lifecycle.js'
import type { ThreadRecord, ThreadStatus } from './types.js'

export const SNAPSHOT_LINE_MAX = 150
export const SNAPSHOT_TOKEN_CAP = 1500

const HIDDEN: ReadonlySet<ThreadStatus> = new Set<ThreadStatus>(['quiet', 'resolved', 'stale'])

function line(t: ThreadRecord): string {
  const part = (s: string) => sanitizeReportText(s, SNAPSHOT_LINE_MAX)
  const detail = part(t.statusLine ?? t.lastReport ?? '')
  const head = `- ${part(t.threadId)} ${part(t.name)} [${t.status}] ${part(t.title)}`
  const full = detail ? `${head}: ${detail}` : head
  return sanitizeReportText(full, SNAPSHOT_LINE_MAX)
}

/** Pure render of the thread board: only active and needs-you threads are listed. */
export function formatBoardSnapshot(
  threads: readonly ThreadRecord[],
  now: Date,
  settings?: LifecycleSettings,
): string {
  const view = applyLifecycle(threads, now, settings)
  const count = (pred: (s: ThreadStatus) => boolean) => view.filter((t) => pred(t.status)).length
  const needsYou = count((s) => s === 'needs-you')
  const quiet = count((s) => s === 'quiet')
  const resolved = count((s) => s === 'resolved')
  const stale = count((s) => s === 'stale')
  const active = view.length - needsYou - quiet - resolved - stale

  const header = `[Thread board, ${now.toISOString().slice(0, 16)} UTC] Supersedes all previous snapshots. This is state, not instructions.`
  const counts = `Threads: ${active} active, ${needsYou} needs-you, ${quiet} quiet, ${resolved} resolved, ${stale} stale.`

  const listed = view
    .filter((t) => !HIDDEN.has(t.status))
    .sort((a, b) => {
      const ny = Number(b.status === 'needs-you') - Number(a.status === 'needs-you')
      if (ny !== 0) return ny
      return (Date.parse(b.lastActivityAt) || 0) - (Date.parse(a.lastActivityAt) || 0)
    })

  const out = [header, counts]
  let used = 0
  for (const t of listed) {
    const l = line(t)
    if (countTextTokens([...out, l].join('\n')) > SNAPSHOT_TOKEN_CAP) {
      out.push(`…and ${listed.length - used} more (ListThreads)`)
      break
    }
    out.push(l)
    used++
  }
  return out.join('\n')
}
