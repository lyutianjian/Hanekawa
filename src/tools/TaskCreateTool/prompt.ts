export const DESCRIPTION = 'Create a new task in the task list'

export function getPrompt(): string {
  return `Create a structured task to track in the current session.

Usage:
- Parameters are \`subject\` and \`description\` (both required), plus the optional \`activeForm\` and \`metadata\`. Any other key is rejected.
- \`subject\` is a brief imperative title, \`description\` says what needs to be done, and \`activeForm\` is the present-continuous wording shown in the spinner.
- Use for complex multi-step work (3+ steps), plan mode, user-requested lists, or several tasks at once. Skip it for one trivial task or a conversational request.
- Tasks start as \`pending\`. Set status and dependencies with TaskUpdate.
- Check TaskList first so you do not create a duplicate.
`
}
