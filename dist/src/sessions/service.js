import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getSessionsDir } from '../utils/paths.js';
import { readJsonFile, writeJsonFile } from '../utils/json.js';
export class SessionStore {
    sessionsDir;
    constructor(cwd) {
        this.sessionsDir = getSessionsDir(cwd);
    }
    async init() {
        await mkdir(this.sessionsDir, { recursive: true });
    }
    async create(title) {
        const now = new Date().toISOString();
        const id = randomUUID();
        const meta = {
            id,
            shortId: id.slice(0, 12),
            createdAt: now,
            updatedAt: now,
            title,
            messageCount: 0,
        };
        await this.writeSession({ meta, records: [] });
        await this.upsertIndex(meta);
        return meta;
    }
    async list() {
        const index = await this.readIndex();
        return index.sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    }
    async resolve(idOrPrefix) {
        const sessions = await this.list();
        const exact = sessions.find((session) => session.id === idOrPrefix || session.shortId === idOrPrefix);
        if (exact)
            return exact;
        const partial = sessions.filter((session) => session.id.startsWith(idOrPrefix) || session.shortId.startsWith(idOrPrefix));
        if (partial.length === 1)
            return partial[0];
        return undefined;
    }
    async load(sessionIdOrPrefix) {
        const session = await this.resolve(sessionIdOrPrefix);
        return session;
    }
    async loadRecords(sessionIdOrPrefix) {
        const session = await this.resolve(sessionIdOrPrefix);
        if (!session)
            return [];
        const state = await readJsonFile(this.sessionPath(session.id), { meta: session, records: [] });
        return state.records;
    }
    async appendRecord(sessionIdOrPrefix, record) {
        const session = await this.resolve(sessionIdOrPrefix);
        if (!session)
            throw new Error(`Unknown session: ${sessionIdOrPrefix}`);
        const state = await readJsonFile(this.sessionPath(session.id), { meta: session, records: [] });
        state.records.push(record);
        state.meta.updatedAt = new Date().toISOString();
        state.meta.messageCount = state.records.filter((item) => item.type === 'message').length;
        if (!state.meta.title) {
            const firstMessage = state.records.find((item) => item.type === 'message' && item.role === 'user');
            if (firstMessage?.content)
                state.meta.title = firstMessage.content.slice(0, 60);
        }
        await this.writeSession(state);
        await this.upsertIndex(state.meta);
    }
    async delete(sessionIdOrPrefix) {
        const session = await this.resolve(sessionIdOrPrefix);
        if (!session)
            return;
        await rm(this.sessionPath(session.id), { force: true });
        const index = await this.readIndex();
        index.sessions = index.sessions.filter((item) => item.id !== session.id);
        await writeJsonFile(this.indexPath(), index);
    }
    async rename(sessionIdOrPrefix, title) {
        const session = await this.resolve(sessionIdOrPrefix);
        if (!session)
            return;
        const state = await readJsonFile(this.sessionPath(session.id), { meta: session, records: [] });
        state.meta.title = title;
        state.meta.updatedAt = new Date().toISOString();
        await this.writeSession(state);
        await this.upsertIndex(state.meta);
    }
    async readIndex() {
        return readJsonFile(this.indexPath(), { sessions: [] });
    }
    async upsertIndex(meta) {
        const index = await this.readIndex();
        index.sessions = index.sessions.filter((item) => item.id !== meta.id);
        index.sessions.push(meta);
        await writeJsonFile(this.indexPath(), index);
    }
    async writeSession(state) {
        await writeJsonFile(this.sessionPath(state.meta.id), state);
    }
    sessionPath(id) {
        return path.join(this.sessionsDir, `${id}.json`);
    }
    indexPath() {
        return path.join(this.sessionsDir, 'index.json');
    }
}
