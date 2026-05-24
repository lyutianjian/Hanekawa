import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { appendFileSync, readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { getSessionsDir } from '../utils/paths.js'
import { readJsonFile, writeJsonFile, parseJsonLines, parseJsonLinesWithDiagnostics } from '../utils/json.js'
import type { SessionRecord } from '../harness/types.js'
import type { SessionMetricInput, SessionMetric } from '../harness/metrics.js'
import { checkSessionInvariants } from './invariants.js'
import { normalizeDenialState, type DenialState } from '../harness/permissions.js'

export interface CheckpointMapping {
  messageId: string
  commitHash: string
  createdAt: string
}

export interface SessionMeta {
  id: string
  shortId: string
  createdAt: string
  updatedAt: string
  title?: string
  messageCount: number
  compactFailureCount?: number
  denialState?: DenialState
  checkpoints?: CheckpointMapping[]
}

interface SessionState {
  meta: SessionMeta
  records: SessionRecord[]
}

interface SessionIndex {
  sessions: SessionMeta[]
}

export type SessionDiagnosticCode =
  | 'malformed_jsonl'
  | 'missing_session_file'
  | 'index_rebuilt'
  | 'legacy_session_migrated'
  | 'checkpoint_migrated'
  | 'tool_result_before_use'
  | 'checkpoint_missing_message'
  | 'legacy_missing_turn_id'
  | 'turn_mismatch'

export interface SessionDiagnostic {
  code: SessionDiagnosticCode
  severity: 'info' | 'warning'
  message: string
  sessionId?: string
  line?: number
  details?: unknown
}

export interface LoadRecordsResult {
  records: SessionRecord[]
  diagnostics: SessionDiagnostic[]
}

export class SessionStore {
  private static indexLocks = new Map<string, Promise<void>>()
  private sessionsDir: string

  constructor(cwd: string) {
    this.sessionsDir = getSessionsDir(cwd)
  }

  async init(): Promise<void> {
    await mkdir(this.sessionsDir, { recursive: true })
  }

  async create(title?: string): Promise<SessionMeta> {
    const now = new Date().toISOString()
    const id = randomUUID()
    const meta: SessionMeta = {
      id,
      shortId: id.slice(0, 12),
      createdAt: now,
      updatedAt: now,
      title,
      messageCount: 0,
    }
    await writeFile(this.sessionJsonlPath(id), '', { flag: 'a' })
    await this.upsertIndex(meta)
    return meta
  }

  async list(): Promise<SessionMeta[]> {
    const index = await this.readIndex()
    return index.sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  async resolve(idOrPrefix: string): Promise<SessionMeta | undefined> {
    const sessions = await this.list()
    const exact = sessions.find((session) => session.id === idOrPrefix || session.shortId === idOrPrefix)
    if (exact) return exact
    const partial = sessions.filter((session) => session.id.startsWith(idOrPrefix) || session.shortId.startsWith(idOrPrefix))
    if (partial.length === 1) return partial[0]
    return undefined
  }

  async load(sessionIdOrPrefix: string): Promise<SessionMeta | undefined> {
    const session = await this.resolve(sessionIdOrPrefix)
    return session
  }

  async loadRecords(sessionIdOrPrefix: string): Promise<SessionRecord[]> {
    return (await this.loadRecordsWithDiagnostics(sessionIdOrPrefix)).records
  }

  async loadRecordsWithDiagnostics(sessionIdOrPrefix: string): Promise<LoadRecordsResult> {
    const diagnostics: SessionDiagnostic[] = []
    const session = await this.resolve(sessionIdOrPrefix)
    if (!session) {
      return {
        records: [],
        diagnostics: [{
          code: 'missing_session_file',
          severity: 'warning',
          message: `Session not found: ${sessionIdOrPrefix}`,
          sessionId: sessionIdOrPrefix,
        }],
      }
    }

    const jsonlPath = this.sessionJsonlPath(session.id)
    if (existsSync(jsonlPath)) {
      const content = readFileSync(jsonlPath, 'utf-8')
      const parsed = parseJsonLinesWithDiagnostics<SessionRecord>(content)
      diagnostics.push(...parsed.diagnostics.map((d) => ({
        code: 'malformed_jsonl' as const,
        severity: 'warning' as const,
        message: `Skipped malformed JSONL line ${d.line}: ${d.message}`,
        sessionId: session.id,
        line: d.line,
        details: { raw: d.raw },
      })))
      diagnostics.push(...checkSessionInvariants(parsed.records, session))
      return { records: parsed.records, diagnostics }
    }

    const state = await readJsonFile<SessionState>(this.sessionPath(session.id), { meta: session, records: [] })
    if (state.records.length > 0) {
      const lines = state.records.map(r => JSON.stringify(r)).join('\n') + '\n'
      appendFileSync(jsonlPath, lines, { mode: 0o600 })
      await this.upsertIndex({ ...this.deriveMetaFromRecords(session.id, state.records, state.meta), checkpoints: state.meta.checkpoints })
      await rm(this.sessionPath(session.id), { force: true })
      diagnostics.push({
        code: 'legacy_session_migrated',
        severity: 'info',
        message: `Migrated legacy session JSON to JSONL: ${session.id}`,
        sessionId: session.id,
      })
      if (state.meta.checkpoints && state.meta.checkpoints.length > 0) {
        diagnostics.push({
          code: 'checkpoint_migrated',
          severity: 'info',
          message: `Migrated ${state.meta.checkpoints.length} checkpoint mappings from legacy session JSON.`,
          sessionId: session.id,
        })
      }
      diagnostics.push(...checkSessionInvariants(state.records, state.meta))
      return { records: state.records, diagnostics }
    }

    if (state.meta.checkpoints && state.meta.checkpoints.length > 0) {
      await this.upsertIndex({ ...session, checkpoints: state.meta.checkpoints })
      diagnostics.push({
        code: 'checkpoint_migrated',
        severity: 'info',
        message: `Migrated ${state.meta.checkpoints.length} checkpoint mappings from legacy session JSON.`,
        sessionId: session.id,
      })
    }

    diagnostics.push(...checkSessionInvariants(state.records, { ...session, checkpoints: state.meta.checkpoints }))
    return { records: state.records, diagnostics }
  }

  async appendRecord(sessionIdOrPrefix: string, record: SessionRecord): Promise<void> {
    const session = await this.resolve(sessionIdOrPrefix)
    if (!session) throw new Error(`Unknown session: ${sessionIdOrPrefix}`)

    // Append to JSONL file (atomic append, no full read-modify-write)
    const jsonlPath = this.sessionJsonlPath(session.id)
    const line = JSON.stringify(record) + '\n'
    appendFileSync(jsonlPath, line, { mode: 0o600 })

    const now = new Date().toISOString()
    await this.withIndexLock(async () => {
      const index = await this.readIndexUnlocked()
      const current = index.sessions.find((item) => item.id === session.id) ?? session
      const content = existsSync(jsonlPath) ? readFileSync(jsonlPath, 'utf-8') : ''
      const records = parseJsonLines<SessionRecord>(content)
      const meta: SessionMeta = {
        ...this.deriveMetaFromRecords(session.id, records, current),
        updatedAt: now,
        ...(current.checkpoints ? { checkpoints: current.checkpoints } : {}),
        ...(current.compactFailureCount ? { compactFailureCount: current.compactFailureCount } : {}),
        ...(current.denialState ? { denialState: current.denialState } : {}),
      }
      this.replaceIndexSession(index, meta)
      await writeJsonFile(this.indexPath(), index)
    })
  }

  async updateRecord(
    sessionIdOrPrefix: string,
    recordId: string,
    update: (record: SessionRecord) => SessionRecord,
  ): Promise<void> {
    const session = await this.resolve(sessionIdOrPrefix)
    if (!session) throw new Error(`Unknown session: ${sessionIdOrPrefix}`)

    const jsonlPath = this.sessionJsonlPath(session.id)
    const content = existsSync(jsonlPath) ? readFileSync(jsonlPath, 'utf-8') : ''
    const records = parseJsonLines<SessionRecord>(content)
    const index = records.findIndex((record) => record.id === recordId)
    if (index < 0) return

    const current = records[index]
    if (!current) return
    records[index] = update(current)
    const nextContent = records.map((record) => JSON.stringify(record)).join('\n') + (records.length > 0 ? '\n' : '')
    await writeFile(jsonlPath, nextContent, 'utf-8')

    const now = new Date().toISOString()
    await this.withIndexLock(async () => {
      const indexFile = await this.readIndexUnlocked()
      const currentMeta = indexFile.sessions.find((item) => item.id === session.id) ?? session
      const meta: SessionMeta = {
        ...this.deriveMetaFromRecords(session.id, records, currentMeta),
        updatedAt: now,
        ...(currentMeta.checkpoints ? { checkpoints: currentMeta.checkpoints } : {}),
        ...(currentMeta.compactFailureCount ? { compactFailureCount: currentMeta.compactFailureCount } : {}),
        ...(currentMeta.denialState ? { denialState: currentMeta.denialState } : {}),
      }
      this.replaceIndexSession(indexFile, meta)
      await writeJsonFile(this.indexPath(), indexFile)
    })
  }

  async appendMetric(sessionIdOrPrefix: string, metric: SessionMetricInput): Promise<void> {
    try {
      const session = await this.resolve(sessionIdOrPrefix)
      const sessionId = session?.id ?? sessionIdOrPrefix
      const record: SessionMetric = {
        created_at: new Date().toISOString(),
        session_id: sessionId,
        ...metric,
      } as SessionMetric
      const metricsPath = this.sessionMetricsPath(sessionId)
      appendFileSync(metricsPath, `${JSON.stringify(record)}\n`, { mode: 0o600 })
      if (metric.event === 'turn' || metric.event === 'cache_break') {
        const summary = this.buildSessionCacheSummary(sessionId, metricsPath)
        if (summary) {
          appendFileSync(metricsPath, `${JSON.stringify(summary)}\n`, { mode: 0o600 })
        }
      }
    } catch {
      // Metrics are best-effort and must never affect the agent loop.
    }
  }

  async setCompactFailureCount(sessionIdOrPrefix: string, count: number): Promise<void> {
    const session = await this.resolve(sessionIdOrPrefix)
    const sessionId = session?.id ?? sessionIdOrPrefix
    const normalizedCount = Math.max(0, Math.floor(count))
    await this.updateIndexSession(sessionId, (current) => {
      const next: SessionMeta = {
        ...current,
        updatedAt: new Date().toISOString(),
      }
      if (normalizedCount > 0) {
        next.compactFailureCount = normalizedCount
      } else {
        delete next.compactFailureCount
      }
      return next
    }, session ?? this.defaultMeta(sessionId))
  }

  async getDenialState(sessionIdOrPrefix: string): Promise<DenialState> {
    const session = await this.load(sessionIdOrPrefix)
    return normalizeDenialState(session?.denialState)
  }

  async setDenialState(sessionIdOrPrefix: string, state: DenialState): Promise<void> {
    const session = await this.resolve(sessionIdOrPrefix)
    const sessionId = session?.id ?? sessionIdOrPrefix
    const normalized = normalizeDenialState(state)
    const base = session ?? this.defaultMeta(sessionId)
    const currentState = normalizeDenialState(base.denialState)
    if (denialStatesEqual(currentState, normalized)) return

    await this.updateIndexSession(sessionId, (current) => {
      const next: SessionMeta = {
        ...current,
        updatedAt: new Date().toISOString(),
      }
      if (normalized.total > 0 || Object.keys(normalized.streaks).length > 0) {
        next.denialState = normalized
      } else {
        delete next.denialState
      }
      return next
    }, base)

    await this.appendMetric(sessionId, {
      event: 'permission_denial_state',
      total_auto_denials: normalized.total,
      active_streaks: Object.keys(normalized.streaks).length,
      max_streak: Math.max(0, ...Object.values(normalized.streaks)),
      streaks: normalized.streaks,
    })
  }

  async delete(sessionIdOrPrefix: string): Promise<void> {
    const session = await this.resolve(sessionIdOrPrefix)
    if (!session) return
    await rm(this.sessionPath(session.id), { force: true })
    await rm(this.sessionJsonlPath(session.id), { force: true })
    await rm(this.sessionMetricsPath(session.id), { force: true })
    await this.withIndexLock(async () => {
      const index = await this.readIndexUnlocked()
      index.sessions = index.sessions.filter((item) => item.id !== session.id)
      await writeJsonFile(this.indexPath(), index)
    })
  }

  async rename(sessionIdOrPrefix: string, title: string): Promise<void> {
    const session = await this.resolve(sessionIdOrPrefix)
    if (!session) return
    await this.updateIndexSession(session.id, (current) => ({
      ...current,
      title,
      updatedAt: new Date().toISOString(),
    }))
  }

  private async updateIndexSession(
    sessionId: string,
    update: (current: SessionMeta) => SessionMeta,
    fallback?: SessionMeta,
  ): Promise<void> {
    await this.withIndexLock(async () => {
      const index = await this.readIndexUnlocked()
      const current = index.sessions.find((item) => item.id === sessionId) ?? fallback ?? this.defaultMeta(sessionId)
      this.replaceIndexSession(index, update(current))
      await writeJsonFile(this.indexPath(), index)
    })
  }

  /**
   * Truncate the JSONL session file to include only records up to and including
   * the record with the given messageId. Returns success/error result.
   */
  async truncateToMessage(sessionId: string, messageId: string): Promise<{ success: boolean; error?: string }> {
    try {
      const jsonlPath = this.sessionJsonlPath(sessionId)

      if (!existsSync(jsonlPath)) {
        return { success: false, error: `Session file not found: ${sessionId}` }
      }

      const content = readFileSync(jsonlPath, 'utf-8')
      const lines = content.split('\n')

      // Find the line containing the target message ID
      let targetLineIndex = -1
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        if (!line.trim()) continue
        try {
          const record = JSON.parse(line) as SessionRecord
          if ('id' in record && record.id === messageId) {
            targetLineIndex = i
            break
          }
        } catch {
          // Skip malformed lines
        }
      }

      if (targetLineIndex === -1) {
        return { success: false, error: `Message not found: ${messageId}` }
      }

      // Keep lines 0 through targetLineIndex (inclusive)
      const retainedLines = lines.slice(0, targetLineIndex + 1)
      const truncatedContent = retainedLines.join('\n') + '\n'

      await writeFile(jsonlPath, truncatedContent, 'utf-8')

      // Update message count in the index
      const retainedRecords = parseJsonLines<SessionRecord>(truncatedContent)
      const retainedMessageIds = new Set(
        retainedRecords
          .filter((record) => record.type === 'message')
          .map((record) => record.id),
      )
      const session = await this.resolve(sessionId)
      if (session) {
        const updatedMeta: SessionMeta = {
          ...this.deriveMetaFromRecords(session.id, retainedRecords, session),
          updatedAt: new Date().toISOString(),
          checkpoints: session.checkpoints?.filter((mapping) => retainedMessageIds.has(mapping.messageId)),
          ...(session.compactFailureCount ? { compactFailureCount: session.compactFailureCount } : {}),
          ...(session.denialState ? { denialState: session.denialState } : {}),
        }
        await this.upsertIndex(updatedMeta)
      }

      return { success: true }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { success: false, error: `Failed to truncate session: ${message}` }
    }
  }

  /**
   * Get checkpoint mappings from session metadata.
   * Returns a Map of messageId -> commitHash.
   */
  async getCheckpointMappings(sessionId: string): Promise<CheckpointMapping[]> {
    try {
      const index = await this.readIndex()
      const session = index.sessions.find((item) => item.id === sessionId || item.shortId === sessionId)
      if (session?.checkpoints && session.checkpoints.length > 0) return session.checkpoints

      const state = await readJsonFile<SessionState>(this.sessionPath(sessionId), {
        meta: { ...(session ?? this.defaultMeta(sessionId)), checkpoints: [] },
        records: [],
      })
      const checkpoints = state.meta.checkpoints ?? []
      if (checkpoints.length > 0) {
        await this.upsertIndex({ ...(session ?? this.defaultMeta(sessionId)), checkpoints })
      }
      return checkpoints
    } catch {
      return []
    }
  }

  /**
   * Add a checkpoint mapping to the session metadata.
   */
  async addCheckpointMapping(sessionId: string, messageId: string, commitHash: string): Promise<void> {
    const session = await this.resolve(sessionId)
    const base = session ?? this.defaultMeta(sessionId)

    const mapping: CheckpointMapping = {
      messageId,
      commitHash,
      createdAt: new Date().toISOString(),
    }

    await this.updateIndexSession(sessionId, (current) => ({
      ...current,
      checkpoints: [...(current.checkpoints ?? []), mapping],
      updatedAt: new Date().toISOString(),
    }), base)
  }

  private async readIndex(): Promise<SessionIndex> {
    return this.withIndexLock(() => this.readIndexUnlocked())
  }

  private async readIndexUnlocked(): Promise<SessionIndex> {
    let index: SessionIndex
    try {
      index = await readJsonFile<SessionIndex>(this.indexPath(), { sessions: [] })
    } catch {
      index = { sessions: [] }
    }

    const recovered = await this.recoverIndex(index)
    if (recovered.changed) {
      await writeJsonFile(this.indexPath(), recovered.index)
    }
    return recovered.index
  }

  private async upsertIndex(meta: SessionMeta): Promise<void> {
    await this.updateIndexSession(meta.id, () => meta, meta)
  }

  private replaceIndexSession(index: SessionIndex, meta: SessionMeta): void {
    index.sessions = index.sessions.filter((item) => item.id !== meta.id)
    index.sessions.push(meta)
  }

  private async withIndexLock<T>(operation: () => Promise<T>): Promise<T> {
    const key = this.indexPath()
    const previous = SessionStore.indexLocks.get(key) ?? Promise.resolve()
    const ready = previous.catch(() => {})
    let release!: () => void
    const current = new Promise<void>((resolve) => {
      release = resolve
    })
    const queued = ready.then(() => current)
    SessionStore.indexLocks.set(key, queued)

    await ready
    try {
      return await operation()
    } finally {
      release()
      if (SessionStore.indexLocks.get(key) === queued) {
        SessionStore.indexLocks.delete(key)
      }
    }
  }

  private async writeSession(state: SessionState): Promise<void> {
    await writeJsonFile(this.sessionPath(state.meta.id), state)
  }

  private async recoverIndex(index: SessionIndex): Promise<{ index: SessionIndex; changed: boolean }> {
    await mkdir(this.sessionsDir, { recursive: true })
    const sessionsById = new Map(index.sessions.map((session) => [session.id, session]))
    let changed = false

    let entries: string[] = []
    try {
      entries = await readdir(this.sessionsDir)
    } catch {
      return { index, changed }
    }

    for (const entry of entries) {
      if (!entry.endsWith('.jsonl')) continue
      const id = entry.slice(0, -'.jsonl'.length)
      if (sessionsById.has(id)) continue
      const filePath = this.sessionJsonlPath(id)
      let records: SessionRecord[]
      try {
        const content = readFileSync(filePath, 'utf-8')
        records = parseJsonLines<SessionRecord>(content)
      } catch {
        continue
      }
      const legacy = await this.readLegacySession(id)
      sessionsById.set(id, this.deriveMetaFromRecords(id, records, legacy?.meta))
      changed = true
    }

    for (const entry of entries) {
      if (!entry.endsWith('.json') || entry === 'index.json') continue
      const id = entry.slice(0, -'.json'.length)
      const legacy = await this.readLegacySession(id)
      if (!legacy) continue
      const current = sessionsById.get(id)
      const checkpoints = legacy.meta.checkpoints ?? current?.checkpoints
      if (!current) {
        sessionsById.set(id, this.deriveMetaFromRecords(id, legacy.records, legacy.meta))
        changed = true
        continue
      }
      if (checkpoints && checkpoints.length > 0 && (current.checkpoints?.length ?? 0) === 0) {
        sessionsById.set(id, { ...current, checkpoints })
        changed = true
      }
    }

    const recoveredIndex = { sessions: [...sessionsById.values()] }
    return { index: recoveredIndex, changed }
  }

  private deriveMetaFromRecords(sessionId: string, records: SessionRecord[], existing?: Partial<SessionMeta>): SessionMeta {
    const messages = records.filter((record) => record.type === 'message')
    const firstUserMessage = messages.find((record) => record.role === 'user')
    const lastRecord = records[records.length - 1]
    const now = new Date().toISOString()
    return {
      id: existing?.id ?? sessionId,
      shortId: existing?.shortId ?? sessionId.slice(0, 12),
      createdAt: existing?.createdAt || records[0]?.createdAt || now,
      updatedAt: lastRecord?.createdAt ?? existing?.updatedAt ?? now,
      title: existing?.title ?? firstUserMessage?.content.slice(0, 60),
      messageCount: messages.length,
      ...(existing?.checkpoints ? { checkpoints: existing.checkpoints } : {}),
      ...(existing?.compactFailureCount ? { compactFailureCount: existing.compactFailureCount } : {}),
      ...(existing?.denialState ? { denialState: existing.denialState } : {}),
    }
  }

  private defaultMeta(sessionId: string): SessionMeta {
    const now = new Date().toISOString()
    return {
      id: sessionId,
      shortId: sessionId.slice(0, 12),
      createdAt: now,
      updatedAt: now,
      messageCount: 0,
    }
  }

  private async readLegacySession(sessionId: string): Promise<SessionState | undefined> {
    try {
      const sessionPath = this.sessionPath(sessionId)
      await stat(sessionPath)
      return await readJsonFile<SessionState>(sessionPath, {
        meta: this.defaultMeta(sessionId),
        records: [],
      })
    } catch {
      return undefined
    }
  }

  private sessionPath(id: string): string {
    return path.join(this.sessionsDir, `${id}.json`)
  }

  private sessionJsonlPath(id: string): string {
    return path.join(this.sessionsDir, `${id}.jsonl`)
  }

  private sessionMetricsPath(id: string): string {
    return path.join(this.sessionsDir, `${id}.metrics.jsonl`)
  }

  private buildSessionCacheSummary(sessionId: string, metricsPath: string): SessionMetric | null {
    if (!existsSync(metricsPath)) return null
    const metrics = parseJsonLines<SessionMetric>(readFileSync(metricsPath, 'utf-8'))
      .filter((metric) => metric.event !== 'session_cache_summary')
    const turns = metrics.filter((metric) => metric.event === 'turn')
    const breaks = metrics.filter((metric) => metric.event === 'cache_break')
    if (turns.length === 0 && breaks.length === 0) return null

    let totalInputTokens = 0
    let totalCacheReadTokens = 0
    for (const turn of turns) {
      totalCacheReadTokens += turn.cache_read_tokens
      totalInputTokens += inferTurnInputTokens(turn)
    }

    const firstBreak = breaks[0]
    const firstBreakTurnCount = firstBreak
      ? turns.filter((turn) => turn.created_at <= firstBreak.created_at).length
      : null
    const causeDistribution: Record<string, number> = {}
    for (const item of breaks) {
      for (const reason of item.reasons) {
        const cause = normalizeCacheBreakCause(reason)
        causeDistribution[cause] = (causeDistribution[cause] ?? 0) + 1
      }
    }
    const denominator = totalInputTokens + totalCacheReadTokens
    return {
      event: 'session_cache_summary',
      created_at: new Date().toISOString(),
      session_id: sessionId,
      total_cache_hit_rate: denominator > 0 ? totalCacheReadTokens / denominator : null,
      total_turns: turns.length,
      first_break_turn_count: firstBreakTurnCount,
      cache_break_count: breaks.length,
      cause_distribution: causeDistribution,
    }
  }

  private indexPath(): string {
    return path.join(this.sessionsDir, 'index.json')
  }
}

function inferTurnInputTokens(turn: Extract<SessionMetric, { event: 'turn' }>): number {
  if (typeof turn.input_tokens === 'number' && Number.isFinite(turn.input_tokens)) {
    return Math.max(0, turn.input_tokens)
  }
  if (turn.cache_hit_rate && turn.cache_hit_rate > 0) {
    const total = turn.cache_read_tokens / turn.cache_hit_rate
    return Math.max(0, total - turn.cache_read_tokens)
  }
  return 0
}

function normalizeCacheBreakCause(reason: string): string {
  const parenIndex = reason.indexOf('(')
  return parenIndex >= 0 ? reason.slice(0, parenIndex) : reason
}

function denialStatesEqual(left: DenialState, right: DenialState): boolean {
  if (left.total !== right.total) return false
  const leftEntries = Object.entries(left.streaks).sort(([a], [b]) => a.localeCompare(b))
  const rightEntries = Object.entries(right.streaks).sort(([a], [b]) => a.localeCompare(b))
  if (leftEntries.length !== rightEntries.length) return false
  return leftEntries.every(([toolName, count], index) => {
    const rightEntry = rightEntries[index]
    return rightEntry?.[0] === toolName && rightEntry[1] === count
  })
}
