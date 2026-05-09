import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import YAML from 'yaml'
import { getSkillsDir } from '../../utils/paths.js'

export interface SkillDefinition {
  name: string
  description: string
  content: string
}

export class SkillsService {
  constructor(private readonly cwd: string) {}

  async list(): Promise<SkillDefinition[]> {
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
        const skill = this.parse(raw)
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

  private parse(raw: string): SkillDefinition {
    const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
    if (!match) {
      throw new Error('Skill file must include YAML frontmatter (---\\n...\\n---)')
    }

    const frontmatter = YAML.parse(match[1]) as { name?: string; description?: string }
    if (!frontmatter.name || !frontmatter.description) {
      throw new Error('Skill frontmatter must include "name" and "description" fields')
    }

    return {
      name: frontmatter.name,
      description: frontmatter.description,
      content: match[2].trim()
    }
  }
}
