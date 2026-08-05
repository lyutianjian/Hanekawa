export const DESCRIPTION = 'Update a task in the task list'

export const PROMPT = `Update a task in the task list. Read the task's latest state with TaskGet before updating.

Use to: mark tasks resolved (only when fully done — not if tests fail, implementation is partial, or errors remain), delete irrelevant tasks, update details, or set dependencies.

Updatable fields: status, subject, description, activeForm, owner, metadata, addBlocks, addBlockedBy.

Status workflow: \`pending\` -> \`in_progress\` -> \`completed\`. Use \`deleted\` to remove.

Example: \`{"taskId": "1", "status": "in_progress"}\`
`
