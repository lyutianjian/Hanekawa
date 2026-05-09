import type { Tool } from '../harness/types.js'
import type { SkillDefinition } from '../services/skills/skillsService.js'

export function createSkillTool(skill: SkillDefinition): Tool {
  return {
    name: `skill_${skill.name}`,
    description: skill.description,
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false
    },
    riskLevel: 'safe',
    async execute() {
      return {
        ok: true,
        content: skill.content
      }
    }
  }
}
