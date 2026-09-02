import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { getSkillsDir } from '../../utils/paths.js'
import { parseYamlFrontmatter } from '../../utils/frontmatter.js'
import { disabledSkillNames, loadMergedSettings } from '../../config/settings.js'
import type { EffortLevel } from '../../config/effort.js'
import type { HookCommand, Hooks } from '../../harness/hooks.js'

export interface SkillDefinition {
  name: string
  description: string
  content: string
  skillDir?: string
  paths?: string[]
  inclusion?: SkillInclusion
  allowedTools?: string[]
  model?: string
  effort?: EffortLevel
  hooks?: Hooks
  attachments?: string[]
}

export type SkillInclusion = 'always' | 'manual' | 'fileMatch'

export class SkillsService {
  constructor(private readonly cwd: string) {}

  /**
   * The skills that are switched on: what the prompt, the slash commands and
   * the `Skill` tool all see.
   *
   * Filtered here rather than at each of the four call sites, because that is
   * what makes "off" mean off everywhere. The settings read is fail-open: a
   * layer that cannot be read must not silently disable every skill.
   */
  async list(): Promise<SkillDefinition[]> {
    const all = await this.listAll()
    let disabled: Set<string>
    try {
      disabled = disabledSkillNames(await loadMergedSettings(this.cwd))
    } catch {
      return all
    }
    return all.filter((skill) => !disabled.has(skill.name))
  }

  /** Every skill on disk, switched off ones included. For the settings screen. */
  async listAll(): Promise<SkillDefinition[]> {
    const skillsDir = getSkillsDir(this.cwd)
    let entries: string[]

    try {
      entries = await readdir(skillsDir)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return []
      }
      throw error
    }

    const skills: SkillDefinition[] = []
    for (const entry of entries) {
      const skillPath = path.join(skillsDir, entry, 'SKILL.md')
      try {
        const raw = await readFile(skillPath, 'utf8')
        const skill = this.parse(raw, path.dirname(skillPath))
        skills.push(skill)
      } catch (error) {
        // Skip skills that can't be read or parsed
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          console.warn(`Failed to load skill from ${entry}:`, (error as Error).message)
        }
      }
    }

    return skills
  }

  async load(name: string): Promise<SkillDefinition> {
    const skills = await this.list()
    const skill = skills.find(s => s.name === name)
    if (!skill) {
      throw new Error(`Skill not found: ${name}`)
    }
    return skill
  }

  private parse(raw: string, skillDir: string): SkillDefinition {
    const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/)
    if (!match) {
      throw new Error('Skill file must include YAML frontmatter (---\\n...\\n---)')
    }

    const frontmatter = parseYamlFrontmatter(match[1]) as {
      name?: unknown
      description?: unknown
      paths?: unknown
      inclusion?: unknown
      allowedTools?: unknown
      model?: unknown
      effort?: unknown
      hooks?: unknown
      attachments?: unknown
    }
    if (!frontmatter.name || !frontmatter.description) {
      throw new Error('Skill frontmatter must include "name" and "description" fields')
    }
    if (typeof frontmatter.name !== 'string' || typeof frontmatter.description !== 'string') {
      throw new Error('Skill frontmatter "name" and "description" fields must be strings')
    }

    const inclusion = parseInclusion(frontmatter.inclusion)
    const paths = parsePaths(frontmatter.paths)
    const allowedTools = parseOptionalStringArray(frontmatter.allowedTools, 'allowedTools')
    const model = parseOptionalString(frontmatter.model, 'model')
    const effort = parseOptionalEffort(frontmatter.effort)
    const hooks = parseHooks(frontmatter.hooks)
    const attachments = parseOptionalStringArray(frontmatter.attachments, 'attachments')

    return {
      name: frontmatter.name,
      description: frontmatter.description,
      content: match[2].trim(),
      skillDir,
      ...(paths ? { paths } : {}),
      inclusion,
      ...(allowedTools ? { allowedTools } : {}),
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      ...(hooks ? { hooks } : {}),
      ...(attachments ? { attachments } : {}),
    }
  }
}

function parseInclusion(value: unknown): SkillInclusion {
  if (value === undefined) return 'manual'
  if (value === 'always' || value === 'manual' || value === 'fileMatch') return value
  throw new Error('Skill frontmatter "inclusion" must be one of: always, manual, fileMatch')
}

function parsePaths(value: unknown): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string' && item.trim() !== '')) {
    throw new Error('Skill frontmatter "paths" must be an array of non-empty glob strings')
  }
  return value
}

function parseOptionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Skill frontmatter "${field}" must be a non-empty string`)
  }
  return value.trim()
}

function parseOptionalStringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string' && item.trim() !== '')) {
    throw new Error(`Skill frontmatter "${field}" must be an array of non-empty strings`)
  }
  return value.map((item) => item.trim())
}

function parseOptionalEffort(value: unknown): EffortLevel | undefined {
  if (value === undefined) return undefined
  if (value === 'low' || value === 'medium' || value === 'high' || value === 'xhigh' || value === 'max') {
    return value
  }
  throw new Error('Skill frontmatter "effort" must be one of: low, medium, high, xhigh, max')
}

function parseHooks(value: unknown): Hooks | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Skill frontmatter "hooks" must be an object')
  }
  const source = value as Record<string, unknown>
  const hooks: Hooks = {}
  for (const key of ['userPromptSubmit', 'preToolUse', 'postToolUse', 'preCompact', 'postCompact', 'stop'] as const) {
    const parsed = parseHookList(source[key], `hooks.${key}`)
    if (parsed) hooks[key] = parsed
  }
  return Object.keys(hooks).length > 0 ? hooks : undefined
}

function parseHookList(value: unknown, field: string): HookCommand[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) {
    throw new Error(`Skill frontmatter "${field}" must be an array`)
  }
  return value.map((item, index) => parseHookCommand(item, `${field}[${index}]`))
}

function parseHookCommand(value: unknown, field: string): HookCommand {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Skill frontmatter "${field}" must be an object`)
  }
  const source = value as Record<string, unknown>
  if (typeof source.command !== 'string' || source.command.trim() === '') {
    throw new Error(`Skill frontmatter "${field}.command" must be a non-empty string`)
  }
  if (source.matcher !== undefined && (typeof source.matcher !== 'string' || source.matcher.trim() === '')) {
    throw new Error(`Skill frontmatter "${field}.matcher" must be a non-empty string`)
  }
  if (source.timeoutMs !== undefined && (typeof source.timeoutMs !== 'number' || !Number.isInteger(source.timeoutMs) || source.timeoutMs < 1)) {
    throw new Error(`Skill frontmatter "${field}.timeoutMs" must be a positive integer`)
  }
  return {
    command: source.command.trim(),
    ...(typeof source.matcher === 'string' ? { matcher: source.matcher.trim() } : {}),
    ...(typeof source.timeoutMs === 'number' ? { timeoutMs: source.timeoutMs } : {}),
  }
}
