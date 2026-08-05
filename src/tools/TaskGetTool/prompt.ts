export const DESCRIPTION = 'Get a task by ID from the task list'

export const PROMPT = `Get a task by ID from the task list. Use to see full description and context before starting work, understand dependencies, or get complete requirements.

Returns: subject, description, status, blocks, blockedBy. Verify blockedBy is empty before starting work.
`
