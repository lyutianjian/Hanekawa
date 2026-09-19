import type { ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type {
  BackgroundTaskRecord,
  BackgroundTaskStatus,
  SessionRecord,
  ToolContext,
  ToolResult,
} from '../../harness/types.js'
import { terminateProcessTree } from './processTree.js'

export const MAX_BACKGROUND_OUTPUT_BYTES = 1_000_000
export const MAX_BACKGROUND_READ_BYTES = 90_000
export const MAX_RETAINED_AGENT_CONTINUATIONS = 8

export interface AgentContinuation {
  resume(message: string, context: ToolContext): Promise<ToolResult>
}

export type AgentMessageDelivery =
  | { kind: 'queued'; agentId: string }
  | { kind: 'resumed'; agentId: string; result: ToolResult }

interface PendingAgentMessage {
  message: string
  context: ToolContext
}

interface AgentRuntimeState {
  pendingMessages: PendingAgentMessage[]
  continuation?: AgentContinuation
  lastUsedAt: number
}

export interface BackgroundTaskSnapshot {
  id: string
  sessionId: string
  kind: 'shell' | 'agent'
  status: BackgroundTaskStatus
  command?: string
  pid?: number
  agentId?: string
  agentType?: string
  description?: string
  startedAt: number
  finishedAt?: number
  exitCode?: number | null
  signal?: string | null
  reason?: string
  outputBytes: number
  unreadBytes: number
}

export interface BackgroundOutputRead {
  task: BackgroundTaskSnapshot
  output: string
  droppedBytes: number
  moreAvailable: boolean
}

interface InternalTask extends BackgroundTaskSnapshot {
  output: ByteRingBuffer
  readCursor: number
  proc?: ChildProcess
  stop?: () => Promise<void> | void
  requestedStatus?: 'failed' | 'killed'
  waiters: Set<() => void>
}

type PersistRecord = (sessionId: string, record: SessionRecord) => Promise<void>

export class BackgroundTaskRegistry {
  private readonly tasks = new Map<string, InternalTask>()
  private readonly counters = new Map<string, { shell: number; agent: number }>()
  private readonly listeners = new Set<() => void>()
  private readonly snapshotCache = new Map<string, readonly BackgroundTaskSnapshot[]>()
  private readonly agentRuntimeStates = new Map<string, AgentRuntimeState>()
  private readonly agentIdCounters = new Map<string, number>()
  private persistenceTail: Promise<void> = Promise.resolve()

  constructor(private readonly persistRecord?: PersistRecord) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = (sessionId: string): readonly BackgroundTaskSnapshot[] => {
    const cached = this.snapshotCache.get(sessionId)
    if (cached) return cached
    const snapshot = [...this.tasks.values()]
      .filter((task) => task.sessionId === sessionId)
      .map((task) => this.toSnapshot(task))
    this.snapshotCache.set(sessionId, snapshot)
    return snapshot
  }

  registerShell(input: { sessionId: string; command: string; proc: ChildProcess }): BackgroundTaskSnapshot {
    const task: InternalTask = {
      id: this.nextId(input.sessionId, 'shell'),
      sessionId: input.sessionId,
      kind: 'shell',
      status: 'running',
      command: input.command,
      ...(input.proc.pid ? { pid: input.proc.pid } : {}),
      startedAt: Date.now(),
      outputBytes: 0,
      unreadBytes: 0,
      output: new ByteRingBuffer(MAX_BACKGROUND_OUTPUT_BYTES),
      readCursor: 0,
      proc: input.proc,
      stop: () => terminateProcessTree(input.proc),
      waiters: new Set(),
    }
    this.addTask(task)
    return this.toSnapshot(task)
  }

  registerAgent(input: {
    sessionId: string
    agentId: string
    agentType: string
    description: string
    stop?: () => Promise<void> | void
  }): BackgroundTaskSnapshot {
    this.seedAgentIdCounter(input.sessionId, input.agentId)
    const task: InternalTask = {
      id: this.nextId(input.sessionId, 'agent'),
      sessionId: input.sessionId,
      kind: 'agent',
      status: 'running',
      agentId: input.agentId,
      agentType: input.agentType,
      description: input.description,
      startedAt: Date.now(),
      outputBytes: 0,
      unreadBytes: 0,
      output: new ByteRingBuffer(MAX_BACKGROUND_OUTPUT_BYTES),
      readCursor: 0,
      stop: input.stop,
      waiters: new Set(),
    }
    this.addTask(task)
    this.agentRuntimeStates.set(this.agentKey(input.sessionId, input.agentId), {
      pendingMessages: [],
      lastUsedAt: Date.now(),
    })
    return this.toSnapshot(task)
  }

  allocateAgentId(sessionId: string, agentType: string): string {
    const normalizedType = agentType.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-') || 'agent'
    const key = `${sessionId}\0${normalizedType}`
    const next = (this.agentIdCounters.get(key) ?? 0) + 1
    this.agentIdCounters.set(key, next)
    return `${normalizedType}-${next}`
  }

  setAgentContinuation(sessionId: string, agentId: string, continuation: AgentContinuation): void {
    const state = this.agentRuntimeStates.get(this.agentKey(sessionId, agentId))
    if (!state) return
    state.continuation = continuation
    state.lastUsedAt = Date.now()
  }

  consumePendingAgentMessages(sessionId: string, agentId: string): string[] {
    const state = this.agentRuntimeStates.get(this.agentKey(sessionId, agentId))
    if (!state || state.pendingMessages.length === 0) return []
    const messages = state.pendingMessages.splice(0)
    state.lastUsedAt = Date.now()
    return messages.map((item) => item.message)
  }

  async sendAgentMessage(
    sessionId: string,
    agentIdOrPrefix: string,
    message: string,
    context: ToolContext,
  ): Promise<AgentMessageDelivery> {
    const task = this.resolveAgentTask(sessionId, agentIdOrPrefix)
    if (!task?.agentId) throw new AgentAddressError('not_found', `Sub-agent not found: ${agentIdOrPrefix}`)
    const state = this.agentRuntimeStates.get(this.agentKey(sessionId, task.agentId))
    if (task.status === 'running') {
      if (!state) throw new AgentAddressError('precondition_failed', `Sub-agent ${task.agentId} is not messageable.`)
      state.pendingMessages.push({ message, context })
      state.lastUsedAt = Date.now()
      return { kind: 'queued', agentId: task.agentId }
    }
    if (task.status !== 'completed' || !state?.continuation) {
      throw new AgentAddressError(
        'precondition_failed',
        `Sub-agent ${task.agentId} is ${task.status} and cannot be resumed.`,
      )
    }

    state.lastUsedAt = Date.now()
    this.transition(task, 'running', { finishedAt: undefined, reason: undefined })
    try {
      let result = await state.continuation.resume(message, context)
      while (state.pendingMessages.length > 0) {
        const pending = state.pendingMessages.shift()!
        result = await state.continuation.resume(pending.message, pending.context)
      }
      this.transition(task, 'completed', {})
      state.lastUsedAt = Date.now()
      this.trimAgentContinuations(sessionId)
      return { kind: 'resumed', agentId: task.agentId, result }
    } catch (error) {
      state.continuation = undefined
      state.pendingMessages.length = 0
      this.transition(task, 'failed', { reason: error instanceof Error ? error.message : String(error) })
      throw error
    }
  }

  appendOutput(sessionId: string, taskId: string, data: Buffer): void {
    const task = this.getInternal(sessionId, taskId)
    if (!task || task.kind !== 'shell') return
    task.output.append(data)
    this.changed(task)
  }

  finishShell(sessionId: string, taskId: string, code: number | null, signal: NodeJS.Signals | null): void {
    const task = this.getInternal(sessionId, taskId)
    if (!task || task.kind !== 'shell' || task.status !== 'running') return
    const status = task.requestedStatus ?? (code === 0 ? 'completed' : 'failed')
    this.transition(task, status, {
      exitCode: code,
      signal,
      ...(status === 'failed' && code !== 0 && !task.reason ? { reason: `Command exited with code ${code}` } : {}),
    })
  }

  fail(sessionId: string, taskId: string, reason: string): void {
    const task = this.getInternal(sessionId, taskId)
    if (!task || task.status !== 'running') return
    this.transition(task, 'failed', { reason })
  }

  completeAgent(sessionId: string, agentId: string, status: 'completed' | 'failed', reason?: string): void {
    const task = [...this.tasks.values()].find((candidate) => candidate.sessionId === sessionId && candidate.agentId === agentId)
    if (!task || task.status !== 'running') return
    const state = this.agentRuntimeStates.get(this.agentKey(sessionId, agentId))
    if (status === 'completed' && state?.continuation && state.pendingMessages.length > 0) {
      void this.finishPendingAgentMessages(task, state)
      return
    }
    this.transition(task, status, reason ? { reason } : {})
    if (state) {
      state.lastUsedAt = Date.now()
      if (status !== 'completed') {
        state.continuation = undefined
        state.pendingMessages.length = 0
      }
    }
    if (status === 'completed') this.trimAgentContinuations(sessionId)
  }

  async stopAgent(sessionId: string, agentId: string, reason = 'Stopped'): Promise<void> {
    const task = [...this.tasks.values()].find((candidate) => candidate.sessionId === sessionId && candidate.agentId === agentId)
    if (!task || task.status !== 'running') return
    await task.stop?.()
    if (task.status === 'running') this.transition(task, 'killed', { reason })
  }

  async killShell(sessionId: string, taskId: string, reason = 'Killed by request', failed = false): Promise<BackgroundTaskSnapshot | undefined> {
    const task = this.getInternal(sessionId, taskId)
    if (!task || task.kind !== 'shell') return task ? this.toSnapshot(task) : undefined
    if (task.status !== 'running') return this.toSnapshot(task)
    task.requestedStatus = failed ? 'failed' : 'killed'
    task.reason = reason
    await task.stop?.()
    if (task.status === 'running') this.transition(task, task.requestedStatus, { reason })
    return this.toSnapshot(task)
  }

  /** Stop this session's running shells started from an identical command string. */
  async killShellsByCommand(sessionId: string, command: string, reason = 'Restarted by a newer run'): Promise<void> {
    const stale = [...this.tasks.values()].filter(
      (task) => task.kind === 'shell' && task.status === 'running' && task.sessionId === sessionId && task.command === command,
    )
    await Promise.allSettled(stale.map((task) => this.killShell(sessionId, task.id, reason)))
  }

  async stopAll(sessionId?: string, reason = 'Session exited'): Promise<void> {
    const running = [...this.tasks.values()].filter((task) => task.status === 'running' && (!sessionId || task.sessionId === sessionId))
    await Promise.allSettled(running.map(async (task) => {
      if (task.kind === 'shell') await this.killShell(task.sessionId, task.id, reason)
      else await this.stopAgent(task.sessionId, task.agentId!, reason)
    }))
    await this.flushPersistence()
  }

  getTask(sessionId: string, taskId: string): BackgroundTaskSnapshot | undefined {
    const task = this.getInternal(sessionId, taskId)
    return task ? this.toSnapshot(task) : undefined
  }

  async readOutput(input: {
    sessionId: string
    taskId: string
    waitMs?: number
    filter?: RegExp
    signal?: AbortSignal
  }): Promise<BackgroundOutputRead | undefined> {
    const task = this.getInternal(input.sessionId, input.taskId)
    if (!task || task.kind !== 'shell') return undefined
    if (task.output.endOffset <= task.readCursor && task.status === 'running' && (input.waitMs ?? 0) > 0) {
      await this.waitForChange(task, input.waitMs!, input.signal)
    }
    const read = task.output.read(task.readCursor, MAX_BACKGROUND_READ_BYTES)
    task.readCursor = read.nextCursor
    let output = read.data.toString('utf8')
    if (input.filter && output) {
      output = output.split(/\r?\n/).filter((line) => {
        input.filter!.lastIndex = 0
        return input.filter!.test(line)
      }).join('\n')
    }
    this.changed(task, false)
    return {
      task: this.toSnapshot(task),
      output,
      droppedBytes: read.droppedBytes,
      moreAvailable: task.output.endOffset > task.readCursor,
    }
  }

  peekOutput(sessionId: string, taskId: string, maxBytes = 4_096): string {
    const task = this.getInternal(sessionId, taskId)
    if (!task || task.kind !== 'shell') return ''
    return task.output.tail(maxBytes).toString('utf8')
  }

  async restoreSession(sessionId: string, records: readonly SessionRecord[]): Promise<string[]> {
    const latest = new Map<string, BackgroundTaskRecord>()
    for (const record of records) {
      if (record.type === 'background_task' && record.sessionId === sessionId) latest.set(record.taskId, record)
    }
    const orphanedAgentIds: string[] = []
    for (const record of latest.values()) {
      this.seedCounter(sessionId, record.taskId, record.kind)
      const task: InternalTask = {
        id: record.taskId,
        sessionId,
        kind: record.kind,
        status: record.status === 'running' ? 'orphaned' : record.status,
        ...(record.command ? { command: record.command } : {}),
        ...(record.pid ? { pid: record.pid } : {}),
        ...(record.agentId ? { agentId: record.agentId } : {}),
        ...(record.agentType ? { agentType: record.agentType } : {}),
        ...(record.description ? { description: record.description } : {}),
        startedAt: record.startedAt,
        ...(record.finishedAt ? { finishedAt: record.finishedAt } : {}),
        ...(record.exitCode !== undefined ? { exitCode: record.exitCode } : {}),
        ...(record.signal !== undefined ? { signal: record.signal } : {}),
        ...(record.reason ? { reason: record.reason } : {}),
        outputBytes: 0,
        unreadBytes: 0,
        output: new ByteRingBuffer(MAX_BACKGROUND_OUTPUT_BYTES),
        readCursor: 0,
        waiters: new Set(),
      }
      this.tasks.set(this.key(sessionId, task.id), task)
      if (task.agentId) this.seedAgentIdCounter(sessionId, task.agentId)
      if (record.status === 'running') {
        task.finishedAt = Date.now()
        task.reason = 'Process was not present when the session resumed'
        this.enqueuePersist(task)
        if (task.agentId) orphanedAgentIds.push(task.agentId)
      }
    }
    this.invalidate(sessionId)
    await this.flushPersistence()
    return orphanedAgentIds
  }

  async flushPersistence(): Promise<void> {
    await this.persistenceTail
  }

  private addTask(task: InternalTask): void {
    this.tasks.set(this.key(task.sessionId, task.id), task)
    this.enqueuePersist(task)
    this.changed(task)
  }

  private transition(task: InternalTask, status: BackgroundTaskStatus, details: Partial<BackgroundTaskSnapshot>): void {
    Object.assign(task, details, { status })
    if (status === 'running') delete task.finishedAt
    else task.finishedAt = Date.now()
    this.enqueuePersist(task)
    this.changed(task)
  }

  private changed(task: InternalTask, notifyWaiters = true): void {
    task.outputBytes = task.output.size
    task.unreadBytes = Math.max(0, task.output.endOffset - Math.max(task.readCursor, task.output.startOffset))
    this.invalidate(task.sessionId)
    if (notifyWaiters) {
      for (const waiter of task.waiters) waiter()
      task.waiters.clear()
    }
    for (const listener of this.listeners) listener()
  }

  private invalidate(sessionId: string): void {
    this.snapshotCache.delete(sessionId)
  }

  private waitForChange(task: InternalTask, waitMs: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.resolve()
    return new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timeout)
        signal?.removeEventListener('abort', finish)
        task.waiters.delete(finish)
        resolve()
      }
      const timeout = setTimeout(finish, waitMs)
      task.waiters.add(finish)
      signal?.addEventListener('abort', finish, { once: true })
    })
  }

  private enqueuePersist(task: InternalTask): void {
    if (!this.persistRecord) return
    const record: BackgroundTaskRecord = {
      id: randomUUID(),
      type: 'background_task',
      taskId: task.id,
      sessionId: task.sessionId,
      kind: task.kind,
      status: task.status,
      ...(task.command ? { command: task.command } : {}),
      ...(task.pid ? { pid: task.pid } : {}),
      ...(task.agentId ? { agentId: task.agentId } : {}),
      ...(task.agentType ? { agentType: task.agentType } : {}),
      ...(task.description ? { description: task.description } : {}),
      startedAt: task.startedAt,
      ...(task.finishedAt ? { finishedAt: task.finishedAt } : {}),
      ...(task.exitCode !== undefined ? { exitCode: task.exitCode } : {}),
      ...(task.signal !== undefined ? { signal: task.signal } : {}),
      ...(task.reason ? { reason: task.reason } : {}),
      createdAt: new Date().toISOString(),
    }
    this.persistenceTail = this.persistenceTail
      .then(() => this.persistRecord!(task.sessionId, record))
      .catch(() => {})
  }

  private toSnapshot(task: InternalTask): BackgroundTaskSnapshot {
    return {
      id: task.id,
      sessionId: task.sessionId,
      kind: task.kind,
      status: task.status,
      ...(task.command ? { command: task.command } : {}),
      ...(task.pid ? { pid: task.pid } : {}),
      ...(task.agentId ? { agentId: task.agentId } : {}),
      ...(task.agentType ? { agentType: task.agentType } : {}),
      ...(task.description ? { description: task.description } : {}),
      startedAt: task.startedAt,
      ...(task.finishedAt ? { finishedAt: task.finishedAt } : {}),
      ...(task.exitCode !== undefined ? { exitCode: task.exitCode } : {}),
      ...(task.signal !== undefined ? { signal: task.signal } : {}),
      ...(task.reason ? { reason: task.reason } : {}),
      outputBytes: task.outputBytes,
      unreadBytes: task.unreadBytes,
    }
  }

  private nextId(sessionId: string, kind: 'shell' | 'agent'): string {
    const counters = this.counters.get(sessionId) ?? { shell: 0, agent: 0 }
    counters[kind] += 1
    this.counters.set(sessionId, counters)
    return `${kind === 'shell' ? 'bash' : 'agent'}_${counters[kind]}`
  }

  private seedCounter(sessionId: string, taskId: string, kind: 'shell' | 'agent'): void {
    const match = taskId.match(/_(\d+)$/)
    if (!match) return
    const counters = this.counters.get(sessionId) ?? { shell: 0, agent: 0 }
    counters[kind] = Math.max(counters[kind], Number(match[1]))
    this.counters.set(sessionId, counters)
  }

  private seedAgentIdCounter(sessionId: string, agentId: string): void {
    const match = agentId.match(/^(.+)-(\d+)$/)
    if (!match?.[1] || !match[2]) return
    const key = `${sessionId}\0${match[1]}`
    this.agentIdCounters.set(key, Math.max(this.agentIdCounters.get(key) ?? 0, Number(match[2])))
  }

  private getInternal(sessionId: string, taskId: string): InternalTask | undefined {
    return this.tasks.get(this.key(sessionId, taskId))
  }

  private key(sessionId: string, taskId: string): string {
    return `${sessionId}\0${taskId}`
  }

  private agentKey(sessionId: string, agentId: string): string {
    return `${sessionId}\0${agentId}`
  }

  private resolveAgentTask(sessionId: string, agentIdOrPrefix: string): InternalTask | undefined {
    const agents = [...this.tasks.values()].filter((task) => task.sessionId === sessionId && task.kind === 'agent' && task.agentId)
    const exact = agents.find((task) => task.agentId === agentIdOrPrefix)
    if (exact) return exact
    const matches = agents.filter((task) => task.agentId!.startsWith(agentIdOrPrefix))
    if (matches.length > 1) {
      throw new AgentAddressError(
        'invalid_input',
        `Ambiguous sub-agent id ${agentIdOrPrefix}: ${matches.map((task) => task.agentId).join(', ')}`,
      )
    }
    return matches[0]
  }

  private trimAgentContinuations(sessionId: string): void {
    const completed = [...this.tasks.values()]
      .filter((task) => task.sessionId === sessionId && task.kind === 'agent' && task.status === 'completed' && task.agentId)
      .map((task) => ({ task, state: this.agentRuntimeStates.get(this.agentKey(sessionId, task.agentId!)) }))
      .filter((entry): entry is { task: InternalTask; state: AgentRuntimeState } => Boolean(entry.state?.continuation))
      .sort((a, b) => a.state.lastUsedAt - b.state.lastUsedAt)
    while (completed.length > MAX_RETAINED_AGENT_CONTINUATIONS) {
      const evicted = completed.shift()!
      evicted.state.continuation = undefined
      evicted.state.pendingMessages.length = 0
    }
  }

  private async finishPendingAgentMessages(task: InternalTask, state: AgentRuntimeState): Promise<void> {
    try {
      while (state.pendingMessages.length > 0) {
        const pending = state.pendingMessages.shift()!
        await state.continuation!.resume(pending.message, pending.context)
      }
      this.transition(task, 'completed', {})
      state.lastUsedAt = Date.now()
      this.trimAgentContinuations(task.sessionId)
    } catch (error) {
      state.continuation = undefined
      state.pendingMessages.length = 0
      this.transition(task, 'failed', { reason: error instanceof Error ? error.message : String(error) })
    }
  }
}

export class AgentAddressError extends Error {
  constructor(readonly code: 'not_found' | 'invalid_input' | 'precondition_failed', message: string) {
    super(message)
    this.name = 'AgentAddressError'
  }
}

export const defaultBackgroundTaskRegistry = new BackgroundTaskRegistry()

class ByteRingBuffer {
  private chunks: Buffer[] = []
  private byteLength = 0
  startOffset = 0
  endOffset = 0

  constructor(private readonly capacity: number) {}

  get size(): number {
    return this.byteLength
  }

  append(data: Buffer): void {
    if (data.length === 0) return
    const chunk = Buffer.from(data)
    this.chunks.push(chunk)
    this.byteLength += chunk.length
    this.endOffset += chunk.length
    while (this.byteLength > this.capacity && this.chunks.length > 0) {
      const excess = this.byteLength - this.capacity
      const first = this.chunks[0]!
      if (first.length <= excess) {
        this.chunks.shift()
        this.byteLength -= first.length
        this.startOffset += first.length
      } else {
        this.chunks[0] = first.subarray(excess)
        this.byteLength -= excess
        this.startOffset += excess
      }
    }
  }

  read(cursor: number, maxBytes: number): { data: Buffer; nextCursor: number; droppedBytes: number } {
    const droppedBytes = Math.max(0, this.startOffset - cursor)
    const start = Math.max(cursor, this.startOffset)
    const length = Math.min(maxBytes, this.endOffset - start)
    return {
      data: this.slice(start - this.startOffset, length),
      nextCursor: start + length,
      droppedBytes,
    }
  }

  tail(maxBytes: number): Buffer {
    const length = Math.min(maxBytes, this.byteLength)
    return this.slice(this.byteLength - length, length)
  }

  private slice(offset: number, length: number): Buffer {
    if (length <= 0) return Buffer.alloc(0)
    const parts: Buffer[] = []
    let skipped = 0
    let remaining = length
    for (const chunk of this.chunks) {
      if (skipped + chunk.length <= offset) {
        skipped += chunk.length
        continue
      }
      const localStart = Math.max(0, offset - skipped)
      const take = Math.min(chunk.length - localStart, remaining)
      parts.push(chunk.subarray(localStart, localStart + take))
      remaining -= take
      skipped += chunk.length
      if (remaining === 0) break
    }
    return Buffer.concat(parts, length - remaining)
  }
}
