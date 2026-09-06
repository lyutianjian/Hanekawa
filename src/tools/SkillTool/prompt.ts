export const SKILL_TOOL_NAME = 'Skill'

export const DESCRIPTION = `Load a skill's instructions into the current conversation.

Usage:
- Parameters are \`skill\` (required) and \`args\` (optional string). Any other key is rejected.
- \`skill\` must be copied exactly from the available-skills list in a system-reminder. Do not guess or invent names; an unknown name is an error, not a search.
- Built-in CLI slash commands (/help, /clear, ...) are not skills. When the user types \`/<name>\` and that name is in the skills list, invoke it here.
- \`args\` is passed through to the skill verbatim as its arguments.
- The skill's instructions are returned for you to follow in this turn; nothing runs on its own.`
