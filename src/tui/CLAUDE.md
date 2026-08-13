# TUI Conventions

Loaded when working under `src/tui/`; the top-level project doc is `../CLAUDE.md`.

## TUI Transcript Mode

Ctrl+O opens transcript history in `AlternateScreen`, which switches the terminal
to the alternate buffer to avoid prompt scrollback redraw and cursor drift. While
that view is mounted, `AlternateScreen` enables xterm alternate-scroll mode
(`?1007h`) so mouse-wheel input maps to the existing up/down arrow scrolling
path when the terminal supports it. It also enables SGR mouse tracking
(`?1006h` + `?1000h`) so `TranscriptView` can directly parse wheel up/down
events as a fallback. Cleanup disables mouse tracking and alternate-scroll
before returning to the primary screen.

`ToolCallBlock`, `CollapsedToolGroup`, and `SubagentTaskBlock` status rows align
flush with the assistant message gutter. Nested tool output remains indented by
`ResponseBlock`.

Successful tool and subagent `●` status prefixes use `rgb(78,186,101)`;
failed tool and subagent `●` status prefixes use `rgb(255,107,128)`.

Agent/subagent rows keep headers compact: `<type> agent(<short summary>) <model>`
plus a `Done (N tool uses · X tokens · Ys)` status line. Expanded views show
`Prompt` from the user-provided Agent task and `Response` from subagent output;
they do not render the internal agent system prompt.

## TUI Markdown Rendering

Markdown rendering in `src/tui/components/Markdown.tsx` uses a hybrid approach:
- **Block-level tokens** (headings, paragraphs, lists, blockquotes) are rendered as React components (`<Text>`/`<Box>`)
- **Tables** are rendered as ANSI strings via `wrap-ansi` for word-wrap, then bridged to Ink via `<AnsiText>`. Includes three-stage column width allocation (ideal → proportional → hard wrap) and automatic vertical format fallback for narrow terminals.
- **Code blocks** use `cli-highlight` for syntax highlighting, rendered via `<AnsiText>`
- **CJK wrapping** is handled at two layers: `insertCjkBreaks()` in `markdown.ts` (application-level spaces at punctuation boundaries) and an Ink patch (`patches/ink+7.0.6.patch`) that inserts zero-width spaces between CJK characters in Ink's internal `wrap-text.js`

Key dependencies: `marked` (parsing), `cli-highlight` (syntax), `wrap-ansi` (table cell wrapping), `string-width` (display width).