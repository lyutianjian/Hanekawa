import { existsSync } from 'node:fs'
import { rename } from 'node:fs/promises'
import path from 'node:path'
import { readJsonFile, writeJsonFile } from '../utils/json.js'
import { getConfigPath, getGlobalConfigPath } from '../utils/paths.js'
import { mergeRouting } from './routing.js'
import type { Config } from './service.js'

/**
 * Folds a project's `.myagent/config.json` into the global one, once.
 *
 * `ConfigService` used to stack the project file on top of `~/.myagent/config.json`
 * and `getSaveTarget()` preferred it, which meant an endpoint's API key was
 * copied into whichever directory happened to be open when it was written, and
 * the same model had to be declared again per repo. The layer is gone; this is
 * what keeps the config a user already has.
 *
 * Deliberately **not** part of `ConfigService.load()`: `load()` is a read, runs
 * on every settings reload, and must stay free of filesystem side effects. This
 * runs once per project, from `bootstrap()`, before the first load.
 *
 * The project's values win on a name collision, because that is what was in
 * effect the moment before this ran — a migration that changes which endpoint a
 * model resolves through is not a migration.
 *
 * Reports rather than throws, following `migrateLegacyTiers`: a config that
 * cannot be moved is a warning on startup, not a reason the app will not open.
 */
export async function migrateProjectConfig(
  cwd: string,
  options: { projectPath?: string; globalPath?: string } = {},
): Promise<string[]> {
  const projectPath = options.projectPath ?? getConfigPath(cwd)
  const globalPath = options.globalPath ?? getGlobalConfigPath()
  // The global workspace's own cwd *is* the home directory, so the two paths are
  // one file — there is nothing to move and copying it onto itself would be the
  // only way to lose it.
  if (path.resolve(projectPath) === path.resolve(globalPath)) return []
  if (!existsSync(projectPath)) return []

  try {
    const project = await readJsonFile<Partial<Config>>(projectPath, {})
    const global = await readJsonFile<Partial<Config>>(globalPath, {})
    const findings: string[] = []

    // Spread project over global for the scalars (`defaultModel` and friends),
    // then rebuild every field that has to merge rather than replace. Fields
    // neither file declares are left out entirely — writing `endpoints: {}` or a
    // fully defaulted `routing` would turn "unset" into "explicitly empty".
    const merged: Partial<Config> = { ...global, ...project }
    if (global.endpoints || project.endpoints) {
      merged.endpoints = { ...global.endpoints, ...project.endpoints }
    }
    if (global.models || project.models) {
      merged.models = { ...global.models, ...project.models }
    }
    if (global.routing || project.routing) {
      merged.routing = mergeRouting(global.routing, project.routing)
    }
    if (global.agent || project.agent) {
      merged.agent = { ...global.agent, ...project.agent }
      if (global.agent?.contextManagement || project.agent?.contextManagement) {
        merged.agent.contextManagement = {
          ...global.agent?.contextManagement,
          ...project.agent?.contextManagement,
        }
      }
    }

    const moved = describeMoved('endpoint', global.endpoints, project.endpoints)
    if (moved) findings.push(moved)
    const movedModels = describeMoved('model', global.models, project.models)
    if (movedModels) findings.push(movedModels)

    await writeJsonFile(globalPath, merged)
    const archive = await archivePath(projectPath)
    await rename(projectPath, archive)
    findings.push(
      `Project config is no longer a layer: ${projectPath} was merged into ${globalPath} and archived as ${path.basename(archive)}.`,
    )
    return findings
  } catch (error) {
    return [
      `Could not migrate ${projectPath} into ${globalPath}: ${error instanceof Error ? error.message : String(error)}`,
    ]
  }
}

/**
 * One line naming what moved and what it overwrote — the part of the migration
 * a user has to be able to check afterwards.
 */
function describeMoved(
  kind: string,
  global: Record<string, unknown> | undefined,
  project: Record<string, unknown> | undefined,
): string | undefined {
  const names = Object.keys(project ?? {})
  if (names.length === 0) return undefined
  const overwritten = names.filter((name) => global && Object.hasOwn(global, name))
  const overwrote = overwritten.length > 0 ? `; replaced the global ${overwritten.join(', ')}` : ''
  return `Moved ${kind}s ${names.join(', ')} into the global config${overwrote}.`
}

/**
 * A free `config.migrated*.json` beside the file being archived.
 *
 * Never overwrites: a second migration (a directory whose config was restored
 * from a backup, say) would otherwise destroy the first one's archive, which is
 * the only copy of what the file held.
 */
async function archivePath(projectPath: string): Promise<string> {
  const dir = path.dirname(projectPath)
  const first = path.join(dir, 'config.migrated.json')
  if (!existsSync(first)) return first
  for (let index = 2; ; index += 1) {
    const candidate = path.join(dir, `config.migrated.${index}.json`)
    if (!existsSync(candidate)) return candidate
  }
}
