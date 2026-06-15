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
