export const DESCRIPTION = `Use this tool when you are in plan mode, have finished writing your plan to the plan file, and are ready for user approval.

## How This Tool Works
- The only parameter is the optional \`plan\`. Normally you omit it: the tool reads the plan from the plan file named in the plan-mode system message. Pass \`plan\` only if you never wrote that file.
- It signals that planning is done; the user then reviews the plan file and approves or rejects it.

## When to Use This Tool
IMPORTANT: only when the task requires planning the implementation steps of work that writes code. For research — gathering information, searching files, reading files, understanding the codebase — do NOT use this tool.

## Before Using This Tool
Ensure your plan is complete and unambiguous:
- If you have unresolved questions about requirements or approach, use AskUserQuestion first, in an earlier phase.
- Once the plan is finalized, use THIS tool to request approval.

**Important:** Do NOT use AskUserQuestion to ask "Is this plan okay?" or "Should I proceed?" — that is exactly what this tool does. ExitPlanMode inherently requests user approval of your plan.`
