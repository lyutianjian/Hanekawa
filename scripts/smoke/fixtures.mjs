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
 * **Why the global files are snapshotted instead of shadowed.** A scratch project
 * used to get a copy of `config.json`, on the theory that `getSaveTarget()` falls
 * back to the global config only when the project has none. That stopped being
 * true: the config layer is **global only** now (`src/config/service.ts:99-125`,
 * `getSaveTarget()` returns `~/.myagent/config.json` unconditionally) and a
 * project-level `config.json` is migrated aside on first load. So the settings
 * step writes the developer's real config however it is launched, and the only
 * honest protection is to snapshot the file up front and put it back in teardown.
 * `~/.myagent/projects.json` gets the same treatment: entering a project registers
 * its root there (`main.ts:275`), so a run would otherwise leave two temp roots in
 * the sidebar's registry — and once the scratch directory is gone, those rows
 * resolve to nothing and every root-keyed command on them fails with
 * "No project is open at …".
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

export function globalConfigPath(home = homedir()) {
  return join(home, '.myagent', 'config.json')
}

export function makeRunDir() {
  // `realpath` because macOS hands out a symlinked temp dir and `projectRootKey`
  // resolves paths — the app would then report a root the driver cannot match.
  return realpathSync(mkdtempSync(join(tmpdir(), 'hanekawa-smoke-')))
}

/**
 * A scratch project directory.
 *
 * No config is seeded: the app reads the global one whatever is on disk here
 * (see the header), and a project `config.json` would only be migrated aside on
 * first load. Sessions and local settings *are* project-level, and those are what
 * this directory is for.
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

/** The config the app actually writes — global, always (see the header). */
export function readGlobalConfig(home = homedir()) {
  return JSON.parse(readFileSync(globalConfigPath(home), 'utf8'))
}

/**
 * The two global files a run is *expected* to write, captured byte for byte.
 *
 * `undefined` text means "did not exist", which restore turns back into "delete
 * it": a run must not leave a `projects.json` behind on a machine that had none.
 */
export function captureGlobalFiles(home = homedir()) {
  const config = globalConfigPath(home)
  if (!existsSync(config)) {
    throw new Error(`no global config at ${config}; the app needs one to launch with real credentials`)
  }
  const read = (path) => (existsSync(path) ? readFileSync(path, 'utf8') : undefined)
  return [
    { label: '~/.myagent/config.json', path: config, text: read(config) },
    { label: '~/.myagent/projects.json', path: join(home, '.myagent', 'projects.json'), text: read(join(home, '.myagent', 'projects.json')) },
  ]
}

/**
 * Puts the snapshot back, and reports what had to change.
 *
 * Byte-for-byte rather than a targeted "delete the smoke endpoint": the run
 * writes routing, models and the project registry too, and enumerating those by
 * hand is how the last three leaks survived. A file that is already identical is
 * not rewritten, so an untouched run reports nothing.
 */
export function restoreGlobalFiles(snapshot) {
  const restored = []
  for (const entry of snapshot) {
    const current = existsSync(entry.path) ? readFileSync(entry.path, 'utf8') : undefined
    if (current === entry.text) continue
    if (entry.text === undefined) rmSync(entry.path, { force: true })
    else writeFileSync(entry.path, entry.text, { mode: 0o600 })
    restored.push(entry.label)
  }
  return restored
}

/**
 * Removes the scratch directory, reporting the failure instead of throwing it.
 *
 * Both callers run in teardown, one of them *after* a fatal error, and a throw
 * there escaped `main()` entirely: the exit code was lost, the tripwires never
 * ran, and the summary had already claimed "(removed)". Windows is what makes
 * this a real path rather than a defensive one — a still-dying Electron holds
 * handles under `.myagent/`, and `rmSync` gives up half-way through with EBUSY.
 * The retries cover that; the return value covers the rest.
 */
export function removeRunDir(runDir) {
  try {
    rmSync(runDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  return existsSync(runDir) ? 'the directory is still there after rm' : undefined
}

/**
 * The tripwires.
 *
 * The app is pointed at a temp directory, so it *cannot* reach the repository's
 * sessions or the global settings — but "cannot" is a claim about code that this
 * driver would be the first thing to disprove. Three cheap mtime/file-set checks
 * turn the claim into a test, and they are what make a tracked script that
 * deletes sessions and rewrites config safe to hand to someone else.
 *
 * `config.json` and `projects.json` are deliberately *not* here: the app writes
 * both by design now, so "was it written" is the wrong question. {@link
 * captureGlobalFiles} asks the right one — is it what it was when we started —
 * and answers it by putting the bytes back.
 */
export function captureTripwires(repoRoot) {
  const stamp = (path) => (existsSync(path) ? statSync(path).mtimeMs : undefined)
  const repoSessions = join(repoRoot, '.myagent', 'sessions')
  return {
    repoSessionIndex: stamp(join(repoSessions, 'index.json')),
    repoSessionFiles: existsSync(repoSessions) ? readdirSync(repoSessions).sort().join(',') : '',
    globalSettings: stamp(join(homedir(), '.myagent', 'settings.json')),
  }
}

export function assertTripwires(repoRoot, before) {
  const after = captureTripwires(repoRoot)
  const broken = []
  if (after.repoSessionIndex !== before.repoSessionIndex) broken.push("the repo's session index was written")
  if (after.repoSessionFiles !== before.repoSessionFiles) broken.push("the repo's session files changed")
  if (after.globalSettings !== before.globalSettings) broken.push('~/.myagent/settings.json was written')
  if (broken.length > 0) throw new Error(`tripwire: ${broken.join('; ')}`)
}
