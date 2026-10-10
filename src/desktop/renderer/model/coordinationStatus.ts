import type { WireCoordinationThreads, WireThreadInfo, WireThreadStatus } from '../../shellProtocol.js'

/**
 * How a coordination thread's status reads in the renderer: its label, its
 * colour tone, which list section it sits in, and the counts the project row
 * badges. Pure, from wire types only.
 */

export const THREAD_STATUS_LABEL: Readonly<Record<WireThreadStatus, string>> = {
  running: '运行中',
  idle: '空闲',
  'awaiting-coordinator': '等协调者',
  'needs-you': '需要你',
  failed: '失败',
  interrupted: '被中断',
  quiet: '安静',
  resolved: '已结案',
  stale: '失效',
}

export type ThreadTone = 'running' | 'attention' | 'danger' | 'neutral' | 'muted'

export function threadTone(status: WireThreadStatus): ThreadTone {
  switch (status) {
    case 'running':
      return 'running'
    case 'needs-you':
      return 'attention'
    case 'failed':
    case 'interrupted':
      return 'danger'
    case 'idle':
    case 'awaiting-coordinator':
      return 'neutral'
    case 'quiet':
    case 'resolved':
    case 'stale':
      return 'muted'
  }
}

export type ThreadBucket = 'active' | 'quiet' | 'resolved'

/** A stale thread (its session is gone) is as finished as a resolved one. */
export function threadBucket(status: WireThreadStatus): ThreadBucket {
  if (status === 'quiet') return 'quiet'
  if (status === 'resolved' || status === 'stale') return 'resolved'
  return 'active'
}

export function coordinationCounts(threads: readonly WireThreadInfo[]): { running: number; needsYou: number } {
  let running = 0
  let needsYou = 0
  for (const thread of threads) {
    if (thread.status === 'running') running += 1
    else if (thread.status === 'needs-you') needsYou += 1
  }
  return { running, needsYou }
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** 刚刚 / N 分钟前 / N 小时前 / N 天前. An unreadable timestamp reads as empty. */
export function formatLastActivity(iso: string, now: number): string {
  const at = Date.parse(iso)
  if (Number.isNaN(at)) return ''
  const elapsed = Math.max(0, now - at)
  if (elapsed < MINUTE) return '刚刚'
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)} 分钟前`
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)} 小时前`
  return `${Math.floor(elapsed / DAY)} 天前`
}

export function threadBySession(
  state: WireCoordinationThreads | undefined,
  sessionId: string,
): WireThreadInfo | undefined {
  return state?.threads.find((thread) => thread.sessionId === sessionId)
}
