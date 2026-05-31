import { z } from 'zod/v3'
import type { Tool } from '../harness/types.js'
import { SkillsService } from '../services/skills/skillsService.js'
import { evictOldestIfNeeded } from '../utils/cache.js'

export function createSkillTool(): Tool {
  return {
    name: 'Skill',
    description: [
      'Execute a skill within the main conversation.',
      'Available skills are listed in system-reminder messages.',
      'Set `skill` to the exact name of an available skill and optional `args` to pass arguments.',
    ].join('\n'),
    inputSchema: z.object({
      skill: z.string()
        .min(1)
        .describe('The name of a skill from the available-skills list. Do not guess names.'),
      args: z.string()
        .describe('Optional arguments for the skill')
        .optional(),
    }).strict(),
    riskLevel: 'safe',
    userFacingName: () => 'Skill',
    getToolUseSummary(input) {
      const skill = typeof input === 'object' && input !== null
        ? (input as { skill?: unknown }).skill
        : undefined
      return typeof skill === 'string' ? skill : null
    },
    getActivityDescription(input) {
      const skill = typeof input === 'object' && input !== null
        ? (input as { skill?: unknown }).skill
        : undefined
      return typeof skill === 'string' ? `Loading skill ${skill}` : 'Loading skill'
    },
    async execute(input, context) {
      const parsed = parseSkillInput(input)
      const service = new SkillsService(context.cwd)
      const skill = await service.load(parsed.skill)
      context.invokedSkills ??= new Map()
      evictOldestIfNeeded(context.invokedSkills, 50)
      context.invokedSkills.set(skill.name, {
        content: skill.content,
        timestamp: Date.now(),
      })
      const content = parsed.args
        ? `${skill.content}\n\nArguments: ${parsed.args}`
        : skill.content
      return {
        ok: true,
        content,
      }
    }
  }
}

function parseSkillInput(input: unknown): { skill: string; args?: string } {
  if (!input || typeof input !== 'object') {
    throw new Error('Skill input must be an object.')
  }

  const value = input as { skill?: unknown; args?: unknown }
  if (typeof value.skill !== 'string' || value.skill.trim() === '') {
    throw new Error('Skill input must include a non-empty skill name.')
  }

  if (value.args !== undefined && typeof value.args !== 'string') {
    throw new Error('Skill args must be a string when provided.')
  }

  return {
    skill: value.skill,
    args: value.args,
  }
}
