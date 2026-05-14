import type { CommandDefinition } from './types.js'
import { SkillsService } from '../services/skills/skillsService.js'

export const skillsCommand: CommandDefinition = {
  name: 'skills',
  description: 'List available skills',
  run: async (_args, context) => {
    const skills = await new SkillsService(context.cwd).list()
    if (skills.length === 0) {
      context.writeLine('No skills available.')
      return
    }

    const lines = [`Available skills (${skills.length}):`, '']
    for (const skill of skills) {
      lines.push(`  ${skill.name} - ${skill.description}`)
    }
    context.writeLine(lines.join('\n'))
  },
}
