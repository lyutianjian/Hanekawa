import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { withFileLock } from '../../sessions/fileLock.js'
import { getProjectDataDir } from '../../utils/paths.js'
import { enqueueNote as enqueueNoteInto } from './noteQueue.js'
import type { CoordinationFile, CoordinatorNote, CoordinatorState, ThreadRecord } from './types.js'

export function newThreadId(): string {
  return `thr_${randomBytes(6).toString('hex')}`
}

function emptyFile(): CoordinationFile {
  return { version: 1, threads: [] }
}

function emptyCoordinator(sessionId: string): CoordinatorState {
  return { sessionId, notes: [], autoWakeCount: 0, wakeLocked: false }
}

/** Per-project coordination state: the thread table and the coordinator's inbox. */
export class CoordinationStore {
  private readonly dir: string
  private readonly filePath: string
  private readonly lockPath: string

  constructor(cwd: string) {
    this.dir = path.join(getProjectDataDir(cwd), 'coordination')
    this.filePath = path.join(this.dir, 'coordination.json')
    this.lockPath = `${this.filePath}.lock`
  }

  async read(): Promise<CoordinationFile> {
    let raw: string
    try {
      raw = await readFile(this.filePath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyFile()
      throw error
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      throw new Error(`Coordination file is corrupted (${this.filePath}): ${(error as Error).message}`)
    }
    const file = parsed as Partial<CoordinationFile> | null
    if (!file || typeof file !== 'object' || file.version !== 1 || !Array.isArray(file.threads)) {
      throw new Error(`Coordination file is corrupted or unsupported (${this.filePath})`)
    }
    return file as CoordinationFile
  }

  async update(mutator: (f: CoordinationFile) => CoordinationFile | void): Promise<CoordinationFile> {
    return withFileLock(this.lockPath, async () => {
      const draft = structuredClone(await this.read())
      const next = mutator(draft) ?? draft
      await this.write(next)
      return next
    })
  }

  private async write(file: CoordinationFile): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    const tmp = `${this.filePath}.tmp.${randomUUID()}`
    await writeFile(tmp, `${JSON.stringify(file, null, 2)}\n`, 'utf8')
    await rename(tmp, this.filePath)
  }

  async upsertThread(record: ThreadRecord): Promise<void> {
    await this.update((f) => {
      const i = f.threads.findIndex((t) => t.threadId === record.threadId)
      if (i >= 0) f.threads[i] = record
      else f.threads.push(record)
    })
  }

  async patchThread(threadId: string, patch: Partial<ThreadRecord>): Promise<ThreadRecord> {
    let result: ThreadRecord | undefined
    await this.update((f) => {
      const i = f.threads.findIndex((t) => t.threadId === threadId)
      if (i < 0) throw new Error(`Unknown thread: ${threadId}`)
      result = { ...f.threads[i]!, ...patch, threadId }
      f.threads[i] = result
    })
    return result!
  }

  async removeThreadsBySession(sessionIds: string[]): Promise<void> {
    const ids = new Set(sessionIds)
    await this.update((f) => {
      f.threads = f.threads.filter((t) => !ids.has(t.sessionId))
    })
  }

  async getCoordinatorSessionId(): Promise<string | undefined> {
    return (await this.read()).coordinator?.sessionId
  }

  async setCoordinatorSessionId(id: string): Promise<void> {
    await this.update((f) => {
      const cur = f.coordinator
      if (!cur) f.coordinator = emptyCoordinator(id)
      else if (cur.sessionId !== id) f.coordinator = { ...cur, sessionId: id, autoWakeCount: 0, wakeLocked: false }
    })
  }

  /** Forgets the coordinator and its inbox; the thread table stays. */
  async clearCoordinator(): Promise<void> {
    await this.update((f) => {
      delete f.coordinator
    })
  }

  /** Mutates the coordinator state, which must already exist. */
  private async mutateCoordinator(fn: (c: CoordinatorState) => void): Promise<void> {
    await this.update((f) => {
      if (!f.coordinator) throw new Error('No coordinator session registered')
      fn(f.coordinator)
    })
  }

  async enqueueNote(note: CoordinatorNote): Promise<void> {
    await this.mutateCoordinator((c) => {
      c.notes = enqueueNoteInto(c.notes, note)
    })
  }

  async drainNotes(): Promise<CoordinatorNote[]> {
    let taken: CoordinatorNote[] = []
    await this.update((f) => {
      if (!f.coordinator) return
      taken = f.coordinator.notes
      f.coordinator.notes = []
    })
    return taken
  }

  async setPendingSnapshot(text: string | undefined): Promise<void> {
    await this.mutateCoordinator((c) => {
      if (text === undefined) delete c.pendingSnapshot
      else c.pendingSnapshot = text
    })
  }

  async setAutoWakeCount(n: number): Promise<void> {
    await this.mutateCoordinator((c) => {
      c.autoWakeCount = n
    })
  }

  async setWakeLocked(b: boolean): Promise<void> {
    await this.mutateCoordinator((c) => {
      c.wakeLocked = b
    })
  }

  /** The shared notes directory; not created until something writes into it. */
  threadsDir(): string {
    return path.join(this.dir, 'notes')
  }

  async removeAll(): Promise<void> {
    await rm(this.dir, { recursive: true, force: true })
  }
}
