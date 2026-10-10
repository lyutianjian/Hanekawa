/**
 * The side panel's 「线程」 tab, as data: a project's coordination threads
 * split into the active list and two folded sections (安静, 已结案), each row
 * carrying what it draws and which controls it may offer.
 *
 * DOM-free like the rest of `model/`. Status labels and tones come from
 * `coordinationStatus.ts`, so the sidebar and this panel never disagree.
 */

import type { WireCoordinationThreads, WireThreadStatus } from '../../shellProtocol.js'
import { THREAD_STATUS_LABEL, formatLastActivity, threadBucket, threadTone, type ThreadTone } from './coordinationStatus.js'

export type ThreadFold = 'quiet' | 'resolved'

export interface ThreadPanelRow {
  readonly threadId: string
  readonly sessionId: string
  readonly title: string
  readonly statusLabel: string
  readonly tone: ThreadTone
  readonly lastActivity: string
  /** The thread's own one-line status, when it has one. */
  readonly statusLine?: string
  /** The session on screen is this thread's. */
  readonly current: boolean
  /** Running, waiting on the user, or waiting on the coordinator: a stop applies. */
  readonly canStop: boolean
  /** Settled threads (resolved, stale) and live ones have nothing to close out. */
  readonly canResolve: boolean
  /** A stop or resolve for this thread is in flight. */
  readonly pending: boolean
}

export interface ThreadPanelFold {
  readonly count: number
  readonly expanded: boolean
  /** Always populated; the view draws them only while `expanded`. */
  readonly rows: readonly ThreadPanelRow[]
}

export interface ThreadPanelView {
  /** The project has threads at all; without them the tab has nothing to show. */
  readonly available: boolean
  readonly active: readonly ThreadPanelRow[]
  readonly quiet: ThreadPanelFold
  readonly resolved: ThreadPanelFold
}

export interface ThreadPanelInput {
  readonly state: WireCoordinationThreads | undefined
  /** Epoch ms, for the relative time column. */
  readonly now: number
  readonly activeSessionId: string | undefined
  readonly expanded: ReadonlySet<ThreadFold>
  /** Thread ids with a stop or resolve in flight. */
  readonly pending: ReadonlySet<string>
}

const STOPPABLE: ReadonlySet<WireThreadStatus> = new Set(['running', 'needs-you', 'awaiting-coordinator'])
const NOT_RESOLVABLE: ReadonlySet<WireThreadStatus> = new Set(['running', 'needs-you', 'awaiting-coordinator', 'resolved', 'stale'])

export function threadPanelView(input: ThreadPanelInput): ThreadPanelView {
  const threads = input.state?.threads ?? []
  const active: ThreadPanelRow[] = []
  const quiet: ThreadPanelRow[] = []
  const resolved: ThreadPanelRow[] = []
  for (const thread of threads) {
    const row: ThreadPanelRow = {
      threadId: thread.threadId,
      sessionId: thread.sessionId,
      title: thread.title,
      statusLabel: THREAD_STATUS_LABEL[thread.status],
      tone: threadTone(thread.status),
      lastActivity: formatLastActivity(thread.lastActivityAt, input.now),
      ...(thread.statusLine === undefined || thread.statusLine.length === 0 ? {} : { statusLine: thread.statusLine }),
      current: thread.sessionId === input.activeSessionId,
      canStop: STOPPABLE.has(thread.status),
      canResolve: !NOT_RESOLVABLE.has(thread.status),
      pending: input.pending.has(thread.threadId),
    }
    const bucket = threadBucket(thread.status)
    if (bucket === 'active') active.push(row)
    else if (bucket === 'quiet') quiet.push(row)
    else resolved.push(row)
  }
  return {
    available: threads.length > 0,
    active,
    quiet: { count: quiet.length, expanded: input.expanded.has('quiet'), rows: quiet },
    resolved: { count: resolved.length, expanded: input.expanded.has('resolved'), rows: resolved },
  }
}

/** What a control in the panel asks the window to do. */
export type ThreadPanelIntent =
  | { readonly kind: 'open'; readonly sessionId: string }
  | { readonly kind: 'stop'; readonly threadId: string }
  | { readonly kind: 'resolve'; readonly threadId: string }
  | { readonly kind: 'stop-all' }
  | { readonly kind: 'toggle-fold'; readonly fold: ThreadFold }
