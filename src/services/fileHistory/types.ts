/**
 * The shapes the rewind panel speaks, kept apart from the service that produces
 * them: the wire, the TUI and the renderer all need these types, and none of
 * them may pull in the service's `node:fs`/`diff` dependencies to get them.
 *
 * "Checkpoint" is the user-facing name for one entry in `/rewind`. It is
 * addressed by `messageId` — the user message the snapshot was taken for —
 * everywhere above the service.
 */

export interface Checkpoint {
  messageId: string
  messageContent: string
  timestamp: string
}

export interface CheckpointDiffSummary {
  fileCount: number
  additions: number
  deletions: number
  firstFile?: string
  hasChanges: boolean
}

export interface CheckpointWithDiff extends Checkpoint {
  turnDiff: CheckpointDiffSummary
  restoreDiff: CheckpointDiffSummary
  isCurrent: boolean
}
