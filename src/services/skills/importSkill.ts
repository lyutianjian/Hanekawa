import { cp, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { getSkillsDir } from '../../utils/paths.js'
import { parseYamlFrontmatter } from '../../utils/frontmatter.js'

/**
 * Copies a skill folder into this project's `.myagent/skills/`.
 *
 * A skill on disk *is* a directory with a `SKILL.md` in it, so importing one is
 * a recursive copy and nothing more — the references, scripts and attachments a
 * skill ships beside its markdown come along by definition. `SkillsService`
 * discovers it on the next `reloadSkills()`; nothing here registers anything.
 *
 * Refuses rather than overwrites. An import that silently replaced a skill of
 * the same name would destroy local edits with no way back, and "已经有一个叫 X
 * 的技能" is a message the user can act on.
 */
export async function importSkill(cwd: string, sourceDir: string): Promise<{ name: string }> {
  const source = path.resolve(sourceDir)
  const manifest = path.join(source, 'SKILL.md')
  let raw: string
  try {
    raw = await readFile(manifest, 'utf8')
  } catch {
    throw new Error(`${source} 里没有 SKILL.md，这不是一个技能文件夹。`)
  }

  const name = skillName(raw) ?? path.basename(source)
  const skillsDir = getSkillsDir(cwd)
  const dest = path.join(skillsDir, name)
  // The name comes out of a file the user did not necessarily write, so it is
  // not trusted to be a single path segment: `../` in it would write anywhere
  // under the project. Checked by containment rather than by pattern, which is
  // the same test `resolveProjectFile` applies to a wire path.
  const within = path.relative(skillsDir, dest)
  if (within === '' || within.startsWith('..') || path.isAbsolute(within)) {
    throw new Error(`技能名「${name}」不能作为文件夹名。`)
  }

  if (await exists(dest)) throw new Error(`已经有一个叫 ${name} 的技能。`)

  await cp(source, dest, { recursive: true })
  return { name }
}

/** The `name` in the frontmatter, if it has one. A malformed file falls back to the folder. */
function skillName(raw: string): string | undefined {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/)
  if (!match?.[1]) return undefined
  try {
    const frontmatter = parseYamlFrontmatter(match[1]) as { name?: unknown }
    return typeof frontmatter.name === 'string' && frontmatter.name.trim() !== ''
      ? frontmatter.name.trim()
      : undefined
  } catch {
    return undefined
  }
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target)
    return true
  } catch {
    return false
  }
}
