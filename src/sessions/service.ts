import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { appendFileSync, readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { getSessionsDir } from '../utils/paths.js'
import { readJsonFile, writeJsonFile } from '../utils/json.js'
import type { SessionRecord } from '../harness/types.js'

export interface SessionMeta {
  id: string
  shortId: string
  createdAt: string
  updatedAt: string
  title?: string
  messageCount: number
}

interface SessionState {
  meta: SessionMeta
  records: SessionRecord[]
}

interface SessionIndex {
  sessions: SessionMeta[]
}

export class SessionStore {
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
    await this.writeSession({ meta, records: [] })
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
    const session = await this.resolve(sessionIdOrPrefix)
    if (!session) return []

    // Try JSONL format first (new format)
    const jsonlPath = this.sessionJsonlPath(session.id)
    if (existsSync(jsonlPath)) {
      const content = readFileSync(jsonlPath, 'utf-8')
      return content.split('\n')
        .filter(line => line.trim())
        .map(line => JSON.parse(line) as SessionRecord)
    }

    // Fall back to JSON format (old format)
    const state = await readJsonFile<SessionState>(this.sessionPath(session.id), { meta: session, records: [] })

    // Auto-migrate to JSONL format
    if (state.records.length > 0) {
      const lines = state.records.map(r => JSON.stringify(r)).join('\n') + '\n'
      appendFileSync(jsonlPath, lines, { mode: 0o600 })
      // Remove old JSON file
      await rm(this.sessionPath(session.id), { force: true })
    }

    return state.records
  }

  async appendRecord(sessionIdOrPrefix: string, record: SessionRecord): Promise<void> {
    const session = await this.resolve(sessionIdOrPrefix)
    if (!session) throw new Error(`Unknown session: ${sessionIdOrPrefix}`)

    // Append to JSONL file (atomic append, no full read-modify-write)
    const jsonlPath = this.sessionJsonlPath(session.id)
    const line = JSON.stringify(record) + '\n'
    appendFileSync(jsonlPath, line, { mode: 0o600 })

    // Update index with new metadata
    const now = new Date().toISOString()
    const meta: SessionMeta = {
      ...session,
      updatedAt: now,
      messageCount: session.messageCount + (record.type === 'message' ? 1 : 0),
    }

    // Set title from first user message if not set
    if (!meta.title && record.type === 'message' && record.role === 'user') {
      meta.title = record.content.slice(0, 60)
    }

    await this.upsertIndex(meta)
  }

  async delete(sessionIdOrPrefix: string): Promise<void> {
    const session = await this.resolve(sessionIdOrPrefix)
    if (!session) return
    await rm(this.sessionPath(session.id), { force: true })
    const index = await this.readIndex()
    index.sessions = index.sessions.filter((item) => item.id !== session.id)
    await writeJsonFile(this.indexPath(), index)
  }

  async rename(sessionIdOrPrefix: string, title: string): Promise<void> {
    const session = await this.resolve(sessionIdOrPrefix)
    if (!session) return
    const state = await readJsonFile<SessionState>(this.sessionPath(session.id), { meta: session, records: [] })
    state.meta.title = title
    state.meta.updatedAt = new Date().toISOString()
    await this.writeSession(state)
    await this.upsertIndex(state.meta)
  }

  private async readIndex(): Promise<SessionIndex> {
    return readJsonFile<SessionIndex>(this.indexPath(), { sessions: [] })
  }

  private async upsertIndex(meta: SessionMeta): Promise<void> {
    const index = await this.readIndex()
    index.sessions = index.sessions.filter((item) => item.id !== meta.id)
    index.sessions.push(meta)
    await writeJsonFile(this.indexPath(), index)
  }

  private async writeSession(state: SessionState): Promise<void> {
    await writeJsonFile(this.sessionPath(state.meta.id), state)
  }

  private sessionPath(id: string): string {
    return path.join(this.sessionsDir, `${id}.json`)
  }

  private sessionJsonlPath(id: string): string {
    return path.join(this.sessionsDir, `${id}.jsonl`)
  }

  private indexPath(): string {
    return path.join(this.sessionsDir, 'index.json')
  }
}
