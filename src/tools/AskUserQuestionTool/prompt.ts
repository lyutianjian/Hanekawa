import { ASK_USER_QUESTION_TOOL_CHIP_WIDTH, EXIT_PLAN_MODE_TOOL_NAME } from '../toolNames.js'

export function buildAskUserQuestionDescription(): string {
  return `Ask the user one to four multiple-choice questions during a turn. Use it to gather preferences, resolve ambiguous instructions, or get a decision on an implementation choice before you commit to one.

Usage:
- The only parameter you send is \`questions\`, an array of 1-4 objects: \`{ question, header, options, multiSelect? }\`. \`answers\` and \`annotations\` are filled in by the UI — never send them.
- \`header\` is a chip label of at most ${ASK_USER_QUESTION_TOOL_CHIP_WIDTH} characters, e.g. "Auth method".
- \`options\` holds 2-4 \`{ label, description, preview? }\` entries. Labels must be unique within a question, and question texts must be unique across the call.
- Do not add an "Other" option; the user always gets one, with free-text input.
- If you recommend an option, put it first and end its label with "(Recommended)".
- Set \`multiSelect: true\` when the choices are not mutually exclusive.
- Use \`preview\` only when concrete artifacts need side-by-side comparison (ASCII mockups, code snippets, diagrams, configuration examples). Previews are rejected on multi-select questions.
- Reserve this for decisions that are genuinely the user's to make. If a sensible default exists, take it and say so instead of asking.
- In plan mode, use this to clarify requirements or choose between approaches; ${EXIT_PLAN_MODE_TOOL_NAME} is what requests plan approval.`
}
