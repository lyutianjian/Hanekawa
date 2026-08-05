export const DESCRIPTION = 'Create a new task in the task list'

export function getPrompt(): string {
  return `Create a structured task to track in the current session. Use for complex multi-step tasks (3+ steps), plan mode, user-requested lists, or multiple tasks. Skip for single trivial tasks or conversational requests.

Fields: subject (brief imperative title), description (what needs to be done), activeForm (optional, present continuous for spinner).

Tasks are created as \`pending\`. Use TaskUpdate to set status and dependencies. Check TaskList first to avoid duplicates.
`
}
