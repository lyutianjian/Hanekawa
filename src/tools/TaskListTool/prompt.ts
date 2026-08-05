export const DESCRIPTION = 'List all tasks in the task list'

export function getPrompt(): string {
  return `List all tasks in the task list. Use to see available work, check progress, find blocked tasks, or find the next task after completing one.

Returns summary of each task: id, subject, status, owner, blockedBy. Use TaskGet for full details.

Prefer working on tasks in ID order (lowest first) when multiple are available.
`
}
