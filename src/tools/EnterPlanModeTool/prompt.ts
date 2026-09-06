export const DESCRIPTION = `Use this tool to enter plan mode when the implementation approach is genuinely ambiguous and getting user input before coding would prevent significant rework.

Usage:
- Takes no parameters. Send an empty object.
- Use when multiple reasonable architectures exist, requirements are unclear, or the task will significantly restructure existing code.
- Skip when the implementation path is clear, the task follows existing conventions, or the user already said "let's do X" — just start. Bug fixes and research tasks do not need plan mode.
- Entering plan mode asks the user for approval; the plan-mode instructions arrive on the next turn.
- Once in plan mode you explore the codebase read-only, clarify with AskUserQuestion, and present the result with ExitPlanMode.
- Sub-agents cannot enter plan mode, and calling this while already in plan mode is an error.`
