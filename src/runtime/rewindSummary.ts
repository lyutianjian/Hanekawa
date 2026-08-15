import { randomUUID } from 'node:crypto'
import type { SessionRecord } from '../harness/types.js'

export type RewindSummaryDecision = 'summarize-from-here' | 'summarize-up-to-here'

export interface RewindSummary {
  summary: string
  preTokens: number
}

export interface RewindSummaryRewrite {
  nextRecords: SessionRecord[]
  boundary: Extract<SessionRecord, { type: 'compact_boundary' }>
  summarizedRecords: SessionRecord[]
}

export async function buildRewindSummaryRewrite(input: {
  records: SessionRecord[]
  targetMessageId: string
  decision: RewindSummaryDecision
  summarize(records: SessionRecord[]): Promise<RewindSummary>
  now?: () => string
  createId?: () => string
}): Promise<RewindSummaryRewrite> {
  const targetIndex = input.records.findIndex((record) =>
    record.type === 'message' && record.role === 'user' && record.id === input.targetMessageId
  )
  if (targetIndex < 0) {
    throw new Error(`Message not found: ${input.targetMessageId}`)
  }

  const summarizeFromHere = input.decision === 'summarize-from-here'
  const recordsToKeepBefore = summarizeFromHere ? input.records.slice(0, targetIndex) : []
  const recordsToSummarize = summarizeFromHere
    ? input.records.slice(targetIndex)
    : input.records.slice(0, targetIndex)
  const recordsToKeepAfter = summarizeFromHere ? [] : input.records.slice(targetIndex)

  if (recordsToSummarize.length === 0) {
    throw new Error('No earlier conversation to summarize.')
  }

  const summary = await input.summarize(recordsToSummarize)
  const boundary: Extract<SessionRecord, { type: 'compact_boundary' }> = {
    id: input.createId?.() ?? randomUUID(),
    type: 'compact_boundary',
    summary: summary.summary,
    preTokens: summary.preTokens,
    postCompactRestore: 'pending',
    createdAt: input.now?.() ?? new Date().toISOString(),
  }

  return {
    nextRecords: [
      ...recordsToKeepBefore,
      boundary,
      ...recordsToKeepAfter,
    ],
    boundary,
    summarizedRecords: recordsToSummarize,
  }
}
