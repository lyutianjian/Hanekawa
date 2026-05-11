import { SkillsService } from '../services/skills/skillsService.js';
export function createSkillTool() {
    return {
        name: 'Skill',
        description: [
            'Execute a skill within the main conversation.',
            'Available skills are listed in system-reminder messages.',
            'Set `skill` to the exact name of an available skill and optional `args` to pass arguments.',
        ].join('\n'),
        inputSchema: {
            type: 'object',
            properties: {
                skill: {
                    type: 'string',
                    description: 'The name of a skill from the available-skills list. Do not guess names.',
                },
                args: {
                    type: 'string',
                    description: 'Optional arguments for the skill',
                },
            },
            required: ['skill'],
            additionalProperties: false
        },
        riskLevel: 'safe',
        async execute(input, context) {
            const parsed = parseSkillInput(input);
            const service = new SkillsService(context.cwd);
            const skill = await service.load(parsed.skill);
            context.invokedSkills ??= new Map();
            context.invokedSkills.set(skill.name, {
                content: skill.content,
                timestamp: Date.now(),
            });
            return {
                ok: true,
                content: skill.content
            };
        }
    };
}
function parseSkillInput(input) {
    if (!input || typeof input !== 'object') {
        throw new Error('Skill input must be an object.');
    }
    const value = input;
    if (typeof value.skill !== 'string' || value.skill.trim() === '') {
        throw new Error('Skill input must include a non-empty skill name.');
    }
    if (value.args !== undefined && typeof value.args !== 'string') {
        throw new Error('Skill args must be a string when provided.');
    }
    return {
        skill: value.skill,
        args: value.args,
    };
}
