import type { RuntimeDiagnostic } from './diagnostics.js'
import type { SessionMetricInput } from './metrics.js'
import type { SessionRecord } from './types.js'

export interface RecordStream {
  load(): Promise<SessionRecord[]>
  loadWithDiagnostics?(): Promise<{ records: SessionRecord[]; diagnostics: RuntimeDiagnostic[] }>
  append(record: SessionRecord): Promise<void>
  appendMetric?(metric: SessionMetricInput): Promise<void>
}

export class MemoryRecordStream implements RecordStream {
  private readonly records: SessionRecord[] = []
  private readonly metrics: SessionMetricInput[] = []

  async load(): Promise<SessionRecord[]> {
    return [...this.records]
  }

  async loadWithDiagnostics(): Promise<{ records: SessionRecord[]; diagnostics: RuntimeDiagnostic[] }> {
    return { records: await this.load(), diagnostics: [] }
  }

  async append(record: SessionRecord): Promise<void> {
    this.records.push(record)
  }

  async appendMetric(metric: SessionMetricInput): Promise<void> {
    this.metrics.push(metric)
  }

  async loadMetrics(): Promise<SessionMetricInput[]> {
    return [...this.metrics]
  }
}
