# Tool Alignment Plan

Reference inspected: `C:\Users\Miyano\Documents\code\ClaudeCode\src`, especially `Tool.ts`, core file/search/bash tools, tool result UI components, and tool orchestration helpers.

## Current Baseline

- Hanekawa tools are intentionally smaller than Claude Code tools: each tool owns schema, risk, concurrency/read-only flags, and execution.
- Before this pass, TUI rendering guessed tool summaries in `ToolCallBlock`, which made display behavior drift from the tool definitions.
- Claude Code's stronger pattern is tool-owned presentation metadata: user-facing name, compact input summary, activity text, result/error rendering, read/search classification, and permission-specific UI.

## Changes Landed

- Added tool-owned display hooks to `Tool`: `userFacingName`, `getToolUseSummary`, `getActivityDescription`, and `shouldDisplayResult`.
- Added `src/tools/display.ts` as the TUI-facing adapter so UI code can consume those hooks without importing React/Ink into tools.
- Updated built-in tools to provide display metadata for file operations, search, bash, Agent, Skill, TodoWrite, EnterPlanMode, ExitPlanMode, and AskUserQuestion.
- Updated `ToolCallBlock`, progress text, and layout row estimation to use tool metadata instead of hard-coded tool-name switches.
- Added structured `tool_result.display` summaries for `Read`, `Grep`, and `Glob`, so the TUI can show count-first collapsed results while preserving the full model-facing `content`.
- Added diff-aware permission previews for `Write`, `Edit`, `MultiEdit`, and `Delete`, including create/overwrite/delete previews and non-crashing fallback messages for ambiguous edits or unsafe paths.
- Added structured execution-result summaries for `Write`, `Edit`, `MultiEdit`, and `Delete`, and made those file mutation results visible in the TUI through the shared display adapter.
- Updated running tool rows to use tool-owned activity descriptions, so Bash, file reads, and file mutations show the specific command/path while running instead of a generic `running...`.
- Fixed the existing full-suite blockers uncovered during verification: endpoint/profile/routing config APIs, plan cache source isolation, and the local `picomatch` type declaration.

## Alignment Strategy

1. Keep the current lightweight `Tool.execute()` contract for compatibility.
2. Move all user-visible tool naming and summaries into tool definitions, following Claude Code's ownership model.
3. Add richer per-tool rendering only when Hanekawa has enough structured output to support it safely.
4. Prefer structured metadata over parsing persisted result strings for future TUI features.
5. Keep tests at both levels: focused tool/TUI behavior and full-suite regression.

## Remaining Gaps

- Claude Code has rich React render hooks for result, rejected, error, queued, grouped, and progress states; Hanekawa currently has string-level hooks only.
- Read/search tools now provide display summaries, but their model-facing output is still plain text rather than fully structured result objects with path/count arrays.
- File edit permission UI now renders approval-time diffs, but rejected/error-specific render states are still string-level compared with Claude Code's richer React render hooks.
- Bash progress now shows command-aware running text, but it still does not stream incremental stdout/stderr into a dedicated shell progress renderer.
- Web, notebook, LSP, and browser-style tools are not in Hanekawa's built-in inventory.

## Next Steps

1. Promote `Read`, `Grep`, and `Glob` from display summaries to fully structured outputs, while preserving model-facing text compatibility.
2. Add richer rejected/error render states for file tools so post-denial and failure display matches the approval-time preview quality.
3. Add progress events with tool-specific payloads for Bash and Agent.
4. Re-run `bun run typecheck` and `bun run test` after each slice.

## Verification

- `bun run typecheck`
- `bun run test`
