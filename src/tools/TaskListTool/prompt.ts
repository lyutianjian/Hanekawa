export const DESCRIPTION = 'List all tasks in the task list'

export function getPrompt(): string {
  return `List every task in the task list.

Usage:
- Takes no parameters. Send an empty object.
- Use it to see available work, check progress, find blocked tasks, or pick the next task after finishing one.
- Returns a summary per task: id, subject, status, owner, blockedBy. Use TaskGet for the full description.
- Prefer working through tasks in ID order (lowest first) when several are available.
`
}
