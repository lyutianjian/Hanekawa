export const BASH_OUTPUT_TOOL_NAME = 'BashOutput'

export const DESCRIPTION = `Read new output from a background Bash task.

Usage:
- Parameters are snake_case: \`task_id\` (required), \`filter\`, \`wait_ms\`. Any other key is rejected.
- \`task_id\` is the id Bash returns when a command is started with \`run_in_background: true\` or moved to the background after a timeout.
- Each read advances that task's cursor, so a second call returns only what arrived since the first. Output already read is not repeated.
- \`filter\` is a regular expression; only matching lines are returned.
- \`wait_ms\` (0-30000) blocks for up to that long waiting for new output. Use it instead of sleeping between polls.
- You are notified when a background task finishes, so do not poll in a loop waiting for one.
- Stop a task with KillShell.`
