# AGENT.md

This file tracks current agent-facing project state alongside `CLAUDE.md` and
`README.md`.

## Current TUI Display State

Tool status rows, collapsed tool-group rows, and subagent task rows align flush
with the assistant message gutter. Nested tool output remains indented through
`ResponseBlock`.

Successful tool and subagent `●` status prefixes use `rgb(78,186,101)`.
Failed tool and subagent `●` status prefixes use `rgb(255,107,128)`.

Agent/subagent rows render as compact task summaries with the routed model and
completion stats. Expanded rows show only the user task under `Prompt` and the
subagent output under `Response`, not the full internal agent prompt.
