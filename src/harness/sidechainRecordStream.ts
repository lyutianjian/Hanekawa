import { appendFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { RuntimeDiagnostic } from './diagnostics.js'
import type { SessionMetricInput } from './metrics.js'
import type { RecordStream } from './recordStream.js'
import type { SessionRecord } from './types.js'
import { parseJsonLinesWithDiagnostics } from '../utils/json.js'
import { getMyAgentDir } from '../utils/paths.js'

export function getSubagentTranscriptPath(cwd: string, parentSessionId: string, agentId: string): string {
  return path.join(getSubagentTranscriptDir(cwd, parentSessionId), `${agentId}.jsonl`)
}

/**
 * The directory holding every subagent transcript of one parent session.
 *
 * Exported so deleting a session can remove the whole thing — one transcript per
 * background agent it ever ran, and nothing else knows they are keyed by the
 * parent's id.
 */
export function getSubagentTranscriptDir(cwd: string, parentSessionId: string): string {
  return path.join(getMyAgentDir(cwd), 'sessions', 'subagents', parentSessionId)
}

export class SidechainRecordStream implements RecordStream {
  constructor(readonly filePath: string) {}

  async load(): Promise<SessionRecord[]> {
    try {
      const content = await readFile(this.filePath, 'utf8')
      return parseJsonLinesWithDiagnostics<SessionRecord>(content).records
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  }

  async loadWithDiagnostics(): Promise<{ records: SessionRecord[]; diagnostics: RuntimeDiagnostic[] }> {
    try {
      const content = await readFile(this.filePath, 'utf8')
      const parsed = parseJsonLinesWithDiagnostics<SessionRecord>(content)
      return {
        records: parsed.records,
        diagnostics: parsed.diagnostics.map((diagnostic) => ({
          code: 'malformed_jsonl',
          severity: 'warning' as const,
          message: `Skipped malformed subagent transcript line ${diagnostic.line}: ${diagnostic.message}`,
        })),
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { records: [], diagnostics: [] }
      throw error
    }
  }

  async append(record: SessionRecord): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true })
    appendFileSync(this.filePath, `${JSON.stringify(record)}\n`, { mode: 0o600 })
  }

  async update(recordId: string, update: (record: SessionRecord) => SessionRecord): Promise<void> {
    const records = await this.load()
    const index = records.findIndex((record) => record.id === recordId)
    if (index < 0) return
    const record = records[index]
    if (!record) return
    records[index] = update(record)
    await mkdir(path.dirname(this.filePath), { recursive: true })
    await writeFile(this.filePath, records.map((item) => JSON.stringify(item)).join('\n') + '\n', 'utf8')
  }

  async appendMetric(_metric: SessionMetricInput): Promise<void> {}
}
