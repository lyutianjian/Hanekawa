# agent.md

This repository is Hanekawa/MyAgent, a TypeScript Ink-based terminal agent with
session persistence, provider routing, skills, MCP integration, permissions, and
checkpoint support.

## Current TUI Transcript Behavior

Ctrl+O opens transcript history through `AlternateScreen`, keeping the transcript
in the terminal alternate buffer so the prompt view avoids scrollback redraw and
cursor drift. While transcript mode is mounted, alternate-scroll mode (`?1007h`)
is enabled so compatible terminals can translate mouse-wheel input into the same
up/down arrow input path that `TranscriptView` already handles. SGR mouse
tracking (`?1006h` + `?1000h`) is also enabled as a fallback; `TranscriptView`
parses wheel up/down reports directly when alternate-scroll mapping is not
provided by the terminal. Cleanup disables mouse tracking and alternate-scroll
before leaving the alternate screen.

## Validation

The transcript wheel-scroll change is covered by `test/tuiCursorSync.test.ts`,
which verifies alternate-scroll enable/disable output and cleanup ordering, and
by `test/tuiRender.test.ts`, which keeps the existing arrow-key scrolling
behavior covered and verifies SGR mouse wheel fallback input.

## Current ToolSearch Prompt State

ToolSearch prompt copy in `src/tools/ToolSearchTool/prompt.ts` uses plain ASCII
punctuation so deferred-tool instructions do not expose mojibake artifacts to
the model. `test/tools.test.ts` includes a regression check for this prompt
text.

### ToolSearch auto:N Threshold Fix

`auto:N` now correctly uses N as the threshold percentage (previously N was
parsed but discarded). Priority: `auto:N` over `HANEKAWA_TOOL_SEARCH_AUTO_PERCENT`
over default 10%. `test/tools.test.ts` covers all edge cases.

### ToolSearch Provider Support

Dynamic ToolSearch now follows provider capabilities:
- Native Anthropic uses `tool_reference` with the `advanced-tool-use-2025-11-20` beta header
- OpenAI and Anthropic-compatible proxy endpoints fall back to full inline tool schemas
- `auto` mode uses deferred tool definition size, including input schemas, before enabling dynamic loading
- `alwaysLoad` tools are not announced as deferred
