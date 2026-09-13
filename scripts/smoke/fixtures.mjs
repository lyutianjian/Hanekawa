/**
 * Scratch projects, seeded sessions, and the tripwires that keep this driver off
 * the developer's own data.
 *
 * **Why sessions are written by hand.** No wire command persists a session.
 * `SessionStore.appendRecord` materialises a draft only for a record of
 * `type: 'message'` (`src/sessions/service.ts:290-295`), and `run-tool` runs on a
 * `MemoryRecordStream` (`src/harness/loop.ts:882`) which writes nothing to the
 * log at all. The only in-app path to a persisted session is a real, paid turn.
 * So the delete/reopen/restart steps seed their own sessions on disk, and
 * `recoverIndex` (`src/sessions/service.ts:896-925`) picks them up: it scans
 * `sessions/*.jsonl`, derives meta with `deriveMetaFromRecords`, and rewrites
 * `index.json`. One file per session is the whole fixture — no index authoring.
 *
 * Two consequences worth knowing before editing: the record's `createdAt` becomes
 * the session's `updatedAt` (and therefore its sort position, newest first), and
 * its `content` becomes the row title, sliced to 60 characters. The driver uses
 * that title as a marker to map a DOM subtree back to a session.
 *
 * Config is global-only, so isolating the project alone is insufficient. The
 * Electron child also gets a disposable home containing a private config copy.
 * Models, project registrations, global sessions and file history all stay
 * inside that home, including when the driver is interrupted.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createTestEnvironment } from '../test-environment.mjs'

export function globalConfigPath(home = homedir()) {
  return join(home, '.myagent', 'config.json')
}

export function createSmokeEnvironment({ keep = false, copyConfig = true, sourceHome = homedir() } = {}) {
  const environment = createTestEnvironment('hanekawa-smoke-', { keep })
  mkdirSync(join(environment.home, '.myagent'))
  if (copyConfig) {
    writeFileSync(globalConfigPath(environment.home), readFileSync(globalConfigPath(sourceHome)), { mode: 0o600 })
  }
  return environment
}

/**
 * A scratch project directory.
 *
 * Config belongs in the disposable home; a project `config.json` would only be
 * migrated aside on first load. This directory holds sessions and local settings.
 */
export function makeProject(runDir, name) {
  const root = join(runDir, name)
  const myagent = join(root, '.myagent')
  mkdirSync(join(myagent, 'sessions'), { recursive: true })
  return { name, root, myagent }
}

/**
 * One persisted session, `ageMinutes` old.
 *
 * Ages are staggered so `list()`'s newest-first order is deterministic: the app
 * bootstraps `sessions.at(0)`, so the youngest fixture is the one that opens by
 * itself (`src/desktop/main.ts:184-185`).
 */
export function seedSession(project, { marker, ageMinutes = 0 }) {
  const id = randomUUID()
  const createdAt = new Date(Date.now() - ageMinutes * 60_000).toISOString()
  const record = { type: 'message', id: randomUUID(), role: 'user', content: marker, createdAt }
  writeFileSync(join(project.myagent, 'sessions', `${id}.jsonl`), `${JSON.stringify(record)}\n`, { mode: 0o600 })
  writeFileSync(join(project.myagent, 'sessions', `${id}.metrics.jsonl`), '', { mode: 0o600 })
  return { id, marker, shortId: id.slice(0, 12) }
}

/**
 * The project-local artifacts a *ran* session leaves outside its own log.
 *
 * Seeded by hand because a fixture session never ran: without them, "delete
 * removes the session memory" would pass against a session that never had any,
 * which is exactly the vacuous assertion stage 4b's leak hid behind.
 *
 * The file history is not among them: it lives under the global
 * `~/.myagent/file-history/`, not in the project.
 */
export function seedArtifacts(project, sessionId) {
  mkdirSync(join(project.myagent, 'session-memory'), { recursive: true })
  writeFileSync(join(project.myagent, 'session-memory', `${sessionId}.json`), '{"entries":[]}\n')
  const subagents = join(project.myagent, 'sessions', 'subagents', sessionId)
  mkdirSync(subagents, { recursive: true })
  writeFileSync(join(subagents, 'agent-1.jsonl'), '')
}

/**
 * Every path `deleteSessionArtifacts` is responsible for.
 *
 * `<id>.json` is the *legacy* single-file format: `SessionStore.delete` removes it
 * but nothing creates it any more, so it is checked for absence and never seeded.
 * `seededArtifactPaths` is the subset a fixture actually has, which is what a
 * before-the-delete assertion must count.
 */
export function artifactPaths(project, sessionId) {
  return [join(project.myagent, 'sessions', `${sessionId}.json`), ...seededArtifactPaths(project, sessionId)]
}

export function seededArtifactPaths(project, sessionId) {
  return [
    join(project.myagent, 'sessions', `${sessionId}.jsonl`),
    join(project.myagent, 'sessions', `${sessionId}.metrics.jsonl`),
    join(project.myagent, 'session-memory', `${sessionId}.json`),
    join(project.myagent, 'sessions', 'subagents', sessionId),
  ]
}

/** The seeded artifacts that exist right now — asserted *before* a delete, too. */
export function existingArtifacts(project, sessionId) {
  return seededArtifactPaths(project, sessionId).filter((path) => existsSync(path))
}

export function indexEntries(project) {
  const path = join(project.myagent, 'sessions', 'index.json')
  if (!existsSync(path)) return []
  try {
    return JSON.parse(readFileSync(path, 'utf8')).sessions ?? []
  } catch {
    return []
  }
}

export function assertArtifactsGone(project, sessionId) {
  const survivors = existingArtifacts(project, sessionId)
  const indexed = indexEntries(project).some((session) => session.id === sessionId)
  if (indexed) survivors.push('index.json entry')
  if (survivors.length > 0) {
    throw new Error(`session ${sessionId.slice(0, 8)} left ${survivors.length} artifact(s): ${survivors.join(', ')}`)
  }
}

export function seedLocalSettings(project, settings) {
  writeFileSync(join(project.myagent, 'settings.local.json'), `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 })
}

export function readLocalSettings(project) {
  const path = join(project.myagent, 'settings.local.json')
  if (!existsSync(path)) return undefined
  return JSON.parse(readFileSync(path, 'utf8'))
}

/** Read the config from the Electron child's disposable home. */
export function readGlobalConfig(home) {
  return JSON.parse(readFileSync(globalConfigPath(home), 'utf8'))
}

/**
 * Assert that the disposable environment kept the run off the developer's
 * sessions, settings, model config and project registry.
 */
export function captureTripwires(repoRoot) {
  const stamp = (path) => (existsSync(path) ? statSync(path).mtimeMs : undefined)
  const repoSessions = join(repoRoot, '.myagent', 'sessions')
  return {
    repoSessionIndex: stamp(join(repoSessions, 'index.json')),
    repoSessionFiles: existsSync(repoSessions) ? readdirSync(repoSessions).sort().join(',') : '',
    globalSettings: stamp(join(homedir(), '.myagent', 'settings.json')),
    globalConfig: stamp(globalConfigPath()),
    globalProjects: stamp(join(homedir(), '.myagent', 'projects.json')),
  }
}

export function assertTripwires(repoRoot, before) {
  const after = captureTripwires(repoRoot)
  const broken = []
  if (after.repoSessionIndex !== before.repoSessionIndex) broken.push("the repo's session index was written")
  if (after.repoSessionFiles !== before.repoSessionFiles) broken.push("the repo's session files changed")
  if (after.globalSettings !== before.globalSettings) broken.push('~/.myagent/settings.json was written')
  if (after.globalConfig !== before.globalConfig) broken.push('~/.myagent/config.json was written')
  if (after.globalProjects !== before.globalProjects) broken.push('~/.myagent/projects.json was written')
  if (broken.length > 0) throw new Error(`tripwire: ${broken.join('; ')}`)
}
