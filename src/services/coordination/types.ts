export type ThreadStatus =
  | 'running'
  | 'idle'
  | 'awaiting-coordinator'
  | 'needs-you'
  | 'failed'
  | 'interrupted'
  | 'quiet'
  | 'resolved'
  | 'stale'

export interface ThreadRecord {
  threadId: string
  sessionId: string
  title: string
  name: string
  brief: string
  background: string
  status: ThreadStatus
  worktree?: { path: string; branch: string }
  createdAt: string
  lastActivityAt: string
  statusLine?: string
  lastReport?: string
}

export interface CoordinatorNote {
  threadId: string
  kind: 'report' | 'question'
  userDriven: boolean
  text: string
  at: string
}

export interface CoordinatorState {
  sessionId: string
  notes: CoordinatorNote[]
  pendingSnapshot?: string
  autoWakeCount: number
  wakeLocked: boolean
}

export interface CoordinationFile {
  version: 1
  coordinator?: CoordinatorState
  threads: ThreadRecord[]
}
