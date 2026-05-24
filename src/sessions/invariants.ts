import type { SessionRecord, ToolResultRecord, ToolUseRecord } from '../harness/types.js'
import type { CheckpointMapping, SessionDiagnostic, SessionMeta } from './service.js'

export interface SessionRepairDiagnostic {
  code: 'tool_protocol_repaired'
  message: string
  recordId?: string
  toolUseId?: string
  tool?: string
}

export interface SessionRepairResult {
  records: SessionRecord[]
  diagnostics: SessionRepairDiagnostic[]
}

export function checkSessionInvariants(
  records: SessionRecord[],
  meta?: Pick<SessionMeta, 'checkpoints'> | { checkpoints?: CheckpointMapping[] },
): SessionDiagnostic[] {
  const diagnostics: SessionDiagnostic[] = []
  const toolUses = new Map<string, { record: Extract<SessionRecord, { type: 'tool_use' }>; index: number }>()
  const toolResults = new Map<string, Array<{ record: Extract<SessionRecord, { type: 'tool_result' }>; index: number }>>()
  const messageIds = new Set<string>()
  let missingTurnIdCount = 0

  for (const [index, record] of records.entries()) {
    if (!record.turnId) missingTurnIdCount++
    if (record.type === 'message') messageIds.add(record.id)
    if (record.type === 'tool_use') toolUses.set(record.id, { record, index })
    if (record.type === 'tool_result') {
      const results = toolResults.get(record.toolUseId) ?? []
      results.push({ record, index })
      toolResults.set(record.toolUseId, results)
    }
  }

  for (const [toolUseId, results] of toolResults) {
    const toolUse = toolUses.get(toolUseId)
    for (const { record, index } of results) {
      if (!toolUse) {
        continue
      }

      if (index < toolUse.index) {
        diagnostics.push({
          code: 'tool_result_before_use',
          severity: 'info',
          message: `tool_result appears before its tool_use: ${record.id}`,
          details: { recordId: record.id, toolUseId, tool: record.tool },
        })
      }

      if (record.turnId && toolUse.record.turnId && record.turnId !== toolUse.record.turnId) {
        diagnostics.push({
          code: 'turn_mismatch',
          severity: 'warning',
          message: `tool_result turnId does not match tool_use turnId: ${record.id}`,
          details: {
            recordId: record.id,
            toolUseId,
            toolUseTurnId: toolUse.record.turnId,
            toolResultTurnId: record.turnId,
          },
        })
      }
    }
  }

  for (const checkpoint of meta?.checkpoints ?? []) {
    if (!messageIds.has(checkpoint.messageId)) {
      diagnostics.push({
        code: 'checkpoint_missing_message',
        severity: 'warning',
        message: `checkpoint points to a missing message: ${checkpoint.messageId}`,
        details: { messageId: checkpoint.messageId, commitHash: checkpoint.commitHash },
      })
    }
  }

  if (missingTurnIdCount > 0) {
    diagnostics.push({
      code: 'legacy_missing_turn_id',
      severity: 'info',
      message: `${missingTurnIdCount} legacy record${missingTurnIdCount === 1 ? '' : 's'} do not have turnId metadata.`,
      details: { count: missingTurnIdCount },
    })
  }

  return diagnostics
}

export function ensureToolResultPairing(records: SessionRecord[]): SessionRepairResult {
  return repairToolResultPairing(records)
}

export function repairToolResultPairing(records: SessionRecord[]): SessionRepairResult {
  const toolUseIds = new Set(records.filter((record) => record.type === 'tool_use').map((record) => record.id))
  const toolResultIds = new Set(records.filter((record) => record.type === 'tool_result').map((record) => record.toolUseId))
  const recordIds = new Set(records.map((record) => record.id))
  const diagnostics: SessionRepairDiagnostic[] = []
  const repaired: SessionRecord[] = []

  for (const record of records) {
    if (record.type === 'tool_use') {
      repaired.push(record)
      if (!toolResultIds.has(record.id)) {
        const syntheticResult: ToolResultRecord = {
          id: uniqueSyntheticRecordId(`${record.id}-lost-result`, recordIds),
          type: 'tool_result',
          toolUseId: record.id,
          tool: record.tool,
          ok: false,
          content: '[Tool result was lost in transport.]',
          ...(record.turnId ? { turnId: record.turnId } : {}),
          createdAt: record.createdAt,
        }
        repaired.push(syntheticResult)
        diagnostics.push({
          code: 'tool_protocol_repaired',
          message: `Inserted synthetic tool_result for orphan tool_use record: ${record.id}`,
          recordId: record.id,
          tool: record.tool,
        })
      }
      continue
    }

    if (record.type === 'tool_result') {
      if (!toolUseIds.has(record.toolUseId)) {
        const syntheticUse: ToolUseRecord = {
          id: record.toolUseId,
          type: 'tool_use',
          tool: record.tool,
          input: {},
          riskLevel: 'safe',
          ...(record.turnId ? { turnId: record.turnId } : {}),
          createdAt: record.createdAt,
        }
        repaired.push(syntheticUse)
        toolUseIds.add(record.toolUseId)
        diagnostics.push({
          code: 'tool_protocol_repaired',
          message: `Inserted synthetic tool_use for orphan tool_result record: ${record.id}`,
          recordId: record.id,
          toolUseId: record.toolUseId,
          tool: record.tool,
        })
      }
      repaired.push(record)
      continue
    }

    repaired.push(record)
  }

  return { records: repaired, diagnostics }
}

function uniqueSyntheticRecordId(baseId: string, recordIds: Set<string>): string {
  let candidate = baseId
  let suffix = 2
  while (recordIds.has(candidate)) {
    candidate = `${baseId}-${suffix}`
    suffix += 1
  }
  recordIds.add(candidate)
  return candidate
}
