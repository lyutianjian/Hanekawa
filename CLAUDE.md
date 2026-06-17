# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Hanekawa (MyAgent) is a self-hosted CLI programming agent for the terminal. TypeScript (ES2022, strict mode, NodeNext modules), Ink/React TUI, supports Anthropic and OpenAI-compatible APIs. Features: session persistence, automatic context compaction, skills, MCP integration, prompt cache management, checkpoints, permission-gated tools, plan mode, lifecycle hooks, and deferred tool loading via ToolSearch.

## Commands

```bash
bun install                              # install dependencies (Node.js >= 22)
bun run dev:tui                          # start TUI (primary interactive mode)
bun run dev:tui resume <id>              # resume a session
bun run dev:tui --continue               # continue most recent session
bun run dev:tui list                     # list sessions
bun run typecheck                        # tsc --noEmit
bun run test                             # run all tests (Node built-in test runner)
node --import tsx --test test/<file>.test.ts   # run a single test file
```

No bundler — runs TypeScript directly via `tsx`. No ESLint/Prettier configured.

## Architecture

### Core Loop (`src/harness/loop.ts`)

`AgentLoop` drives: `prepare records → auto-compact if needed → build context → call model → execute tools → repeat`.

Key modules:

- **`contextBuilder.ts`** — assembles system prompt, skills, environment, session history into `ModelRequest`
- **`toolRunner.ts`** — executes tool calls with ordered batching (safe tools parallel, unsafe sequential), records results, enforces per-result size budgets
- **`permissions.ts`** — five permission modes (`default`, `plan`, `acceptEdits`, `auto`, `bypass`). Protected paths (`.git`, `.myagent`, `.env`, `.ssh`, `.aws`) and secret files (`.gitconfig`, `.bashrc`, `.env`, `.npmrc`, `id_rsa*`, `*.pem`, `*.key`) always blocked. Supports glob-pattern allow/deny/ask rules. Denial streak escalation after repeated denials.
- **`compact.ts`** — token-driven auto-compaction via LLM summary when context exceeds threshold; uses structured 9-section prompt from `compactPrompt.ts` with `<analysis>` scratchpad
- **`compactPrompt.ts`** — structured compact prompt template (9 sections: Primary Request, Key Concepts, Files/Code, Errors, Problem Solving, User Messages, Pending Tasks, Current Work, Next Step) and `formatCompactSummary()` for post-processing
- **`requestPrep.ts`** — prepares session records, enforces two-layer tool result budget, snips oversized individual tool results (50k token cap), repairs tool_use/tool_result pairing
- **`planModeManager.ts`** — plan mode orchestration: enter/exit plan mode, plan file management at `<plansDir>/<slug>.md`, auto-allow plan file writes
- **`hooks.ts`** — lifecycle hooks (`userPromptSubmit`, `preToolUse`, `postToolUse`, `preCompact`, `postCompact`, `subagentStart`, `subagentStop`, `stop`). Hooks run shell commands with glob matchers on tool names, timeout, and output size limits.
- **`progressiveCompact.ts`** — progressive compaction: (1) time-based micro-compact (clears old tool results when gap > 60min), (2) ratio-based micro-compact only when `CacheEditManager`/`cache_edits` is available (90% threshold, registers tool results for API-level deletion instead of local mutation). Conversation snipping has been removed.
- **`cacheEditManager.ts`** — manages Anthropic `cache_edits` blocks for prompt cache-aware compaction. Tracks tool results by `tool_use_id`, produces `cache_edits` blocks to delete old cached results, and manages pinned edits for re-sending across requests. Only active for native Anthropic provider with prompt caching enabled.
- **`systemReminder.ts`** — unified `<system-reminder>` wrapper for dynamic context injection

**Tool result budget — three layers:**

1. Per-result write-time truncation (`toolRunner.ts:applyToolResultBudget`): each tool defines `maxResultSizeChars`; content exceeding that limit is sliced. Current limits: Bash=100k, Grep=30k, Agent=32k chars.
2. Global request-time budget (`requestPrep.ts`): total tool_result content capped at `effectiveContextWindow * 0.5` (floored at 200k tokens). Older results summarized when exceeded, keeping the 10 most recent intact.
3. Per-result hard cap (`compact.ts:snipLargeToolResults`): individual tool results exceeding 50k tokens are truncated with a notice. This is not conversation snipping; it is applied after budget compaction to catch any remaining oversized results.

### Output Token Slot Cap

Default max output tokens are capped to `CAPPED_DEFAULT_MAX_TOKENS = 8,000` to reduce API slot over-reservation (p99 output is ~4,911 tokens). Requests hitting this cap get one retry at `ESCALATED_MAX_TOKENS = 64,000`, then up to 3 multi-turn recovery attempts with continuation reminders. The cap can be bypassed with `MYAGENT_SLOT_CAP_DISABLED=1`.

### Cache-Aware Microcompact (Native Anthropic Only)

When the microcompact threshold (90%) is reached, ratio-based microcompact runs only when `CacheEditManager` is available. It registers tool results with `CacheEditManager`, which produces `cache_edits` blocks for the Anthropic API to delete old cached tool results without breaking the cached prefix. Providers without cache-edit support skip ratio-based microcompact instead of mutating historical tool result records locally.

The cache-aware path is active when:
1. Provider is native Anthropic (`provider.name === 'anthropic'`)
2. Prompt caching is enabled
3. `CacheEditManager` is injected into `applyProgressiveCompaction`

The Anthropic payload builder injects `cache_edits` into the last user message and adds `cache_reference` fields to tool_result blocks in the cached prefix. The `cache-editing-2025-04-11` beta header is included when edits are present.

### Providers (`src/config/providers/`)

Two providers share a `ModelProvider` interface: `anthropicProvider.ts` (Anthropic SDK, streaming, cache diagnostics) and `openaiProvider.ts` (OpenAI Chat Completions with `prompt_cache_key`). Both support extended thinking/reasoning. Payload builders translate a neutral `ModelContextItem` union into provider-specific formats. The Anthropic payload builder (`anthropicPayload.ts`) supports cache edits injection: `pendingCacheEdits` are appended to the last user message, `pinnedCacheEdits` are re-inserted at their original positions (with deduplication), and `cache_reference` fields are added to `tool_result` blocks in the cached prefix.

Max output tokens: default 32k, upper limit 128k (env override or config). Auto-escalates to 64k on `max_tokens` stop reason with up to 3 recovery attempts.

Retry logic (`src/config/retry.ts`): exponential backoff with jitter (base 500ms, max 32s). Per-category budgets: rate_limit(3), overload(2), server_error(3), transient(3). Retries on HTTP 429, 529, 5xx, timeout, ECONNRESET, ECONNREFUSED. Background callers skip 529 retries. `FallbackTriggeredError` triggers model fallback when overload budget exhausted.

### Model Routing (`src/config/routing.ts`)

Three-layer configuration: endpoints (provider + baseUrl + apiKey) → models (model id + endpoint ref) → profiles (tier → model-key: fast/balanced/powerful). Routing maps semantic roles to tiers: `main`, `plan`, `compact`, `subagent` (per-type). Supports `'inherit'` sentinel for fork agents sharing parent prompt-cache.

### Tools (`src/tools/`)

Each tool exports `{ name, inputSchema (Zod), riskLevel, isReadOnly?, isDestructive?, isConcurrencySafe?, execute() }`. Safe tools run in parallel; unsafe tools run sequentially as ordering barriers. The `Agent` and `Skill` tools are created dynamically at runtime.

| Tool | Risk | Read-Only | Notes |
|------|------|-----------|-------|
| Grep | safe | yes | fast-glob, 50 match limit |
| Glob | safe | yes | |
| Read | safe | yes | LRU cache for post-compact restore |
| Bash | dangerous | no | 1MB output, 30s timeout, Windows Git Bash detection |
| Write | confirm | no | |
| Edit | confirm | no | requires prior Read, exactly one match |
| MultiEdit | confirm | no | atomic exact string replacements |
| Delete | dangerous | no | |
| NotebookEdit | confirm | no | Jupyter notebook cell editing |
| WebFetch | safe | yes | URL → Markdown, 15min cache, 30s timeout |
| WebSearch | safe | yes | DuckDuckGo HTML search, no API key |
| Config | safe | no | read/write settings at runtime |
| TaskCreate/List/Get/Update | safe | mixed | task tracking |
| ToolSearch | safe | yes | deferred tool schema loading (Anthropic tool_reference) |
| Skill | safe | no | on-demand skill invocation |
| Agent | safe | input-specific | typed subagent dispatch |

### Sub-Agents (`Agent` tool)

Built-in types: `general` (delegation, inherits project context), `fork` (transcript preload, shares parent prompt-cache stream), `explore` (read-only search with Glob/Grep/Read, omits project context, effort=low), `plan` (read-only planning with Glob/Grep/Read, omits project context, effort=high).

Custom types from `.myagent/agents/*.md` (YAML frontmatter with `name`, `description`, `tools`, `isReadOnlyAgent`, `maxTurns`, `permissionMode`, `skills`, `mcpServers`, `background`, `isolation`, `model`, `effort`). Agent definition directories merge by `name`: `~/.myagent/agents/` → `.myagent/agents/` → `.myagent/agents.local/` (later overrides). `/agents reload` refreshes definitions in the TUI without restart.

Sub-agents always disallow: `Agent`, `EnterPlanMode`, `ExitPlanMode`, `AskUserQuestion`. Background agents restricted to: Read, Glob, Grep, Bash, Write, Edit, MultiEdit, Delete, Skill. Worktree isolation available for non-read-only agents (`isolation: 'worktree'`).

Environment variable overrides: `MYAGENT_SUBAGENT_MODEL_<TYPE>` or `MYAGENT_SUBAGENT_MODEL`.

### Configuration

Three-tier settings merge (lowest → highest priority):
1. `~/.myagent/settings.json` (user)
2. `.myagent/settings.json` (project)
3. `.myagent/settings.local.json` (local override)

Model config at `.myagent/config.json` — endpoints, models, profiles (fast/balanced/powerful), routing (main/plan/compact/subagent). Keybindings at `.myagent/keybindings.json`.

Settings support: `permissions` (mode + allow/deny/ask rules), `autoMode` (allow/deny for auto mode), `hooks` (lifecycle hook commands), `mcpServers`, `effortLevel`, `autoCompact`, `autoCompactThreshold`, `models`, `endpoints`, `profiles`, `routing`.

### Sessions (`src/sessions/`)

JSONL records in `.myagent/sessions/`. Record types: messages, tool_use, tool_result, tool_approval, compact_boundary, compact_attempt_failed, tool_use_summary, subagent_transcript, subagent_task, plan_mode_request, plan_mode_outcome, turn_interruption, at_mention_context. Prefix-based ID resolution.

### TUI Transcript Mode

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

### Skills (`.myagent/skills/<name>/SKILL.md`)

Markdown files with YAML frontmatter (`name`, `description`, optional `allowedTools`, `model`, `effort`, `hooks`, `attachments`). Auto-discovered at TUI startup, injected into system prompt, invocable via the `Skill` tool, and registered as slash commands using the skill `name` when that name is not already used by a built-in command. For example, `name: debugging` is callable as `/debugging args`.

Skill slash commands submit the skill body as a normal query in the background while the TUI shows only the slash invocation, such as `/debugging args`. `$ARGUMENTS` placeholders are replaced with the slash command arguments; if no placeholder exists, non-empty arguments are appended as `Arguments: ...`. Inline shell snippets like ``!`git status` `` run through the normal Bash tool permission gate before submission. Text `attachments` are UTF-8 files resolved inside the skill directory and appended to the prompt. `allowedTools` limits model-visible and executable tools, while `model` and `effort` are temporary per-turn overrides. Skill hooks are merged with session hooks only for the active skill turn. Built-in slash commands take precedence on name conflicts, and new or changed skill commands require restarting the TUI. Image/PDF multimodal attachments are not supported in this stage.

### MCP Integration

Model Context Protocol via `@modelcontextprotocol/sdk` (stdio transport). Config at `.myagent/mcp.json` or settings files under `mcpServers`. Tools wrapped as `mcp__<serverName>__<toolName>`, default risk level `confirm`. MCP tools are deferred by default when ToolSearch is enabled.

### Checkpoints (`src/services/checkpoint/`)

Shadow git repo per session under `.myagent/shadow-git/<session-id>/`. Creates commits on each assistant message, enabling rollback via `git checkout <hash> -- .`. Windows-compatible (`core.symlinks=false`, `core.autocrlf=false`).

### Project Context Discovery

Walks up from cwd looking for `MYAGENT.md`, `CLAUDE.md`, `AGENTS.md`, plus `.myagent/rules/*.md` and local overrides (`MYAGENT.local.md`, `CLAUDE.local.md`). Cached within session.

## TUI Markdown Rendering

Markdown rendering in `src/tui/components/Markdown.tsx` uses a hybrid approach:
- **Block-level tokens** (headings, paragraphs, lists, blockquotes) are rendered as React components (`<Text>`/`<Box>`)
- **Tables** are rendered as ANSI strings via `wrap-ansi` for word-wrap, then bridged to Ink via `<AnsiText>`. Includes three-stage column width allocation (ideal → proportional → hard wrap) and automatic vertical format fallback for narrow terminals.
- **Code blocks** use `cli-highlight` for syntax highlighting, rendered via `<AnsiText>`
- **CJK wrapping** is handled at two layers: `insertCjkBreaks()` in `markdown.ts` (application-level spaces at punctuation boundaries) and an Ink patch (`patches/ink+7.0.6.patch`) that inserts zero-width spaces between CJK characters in Ink's internal `wrap-text.js`

Key dependencies: `marked` (parsing), `cli-highlight` (syntax), `wrap-ansi` (table cell wrapping), `string-width` (display width).

## Ink Patch

The current branch uses a customized Ink build. `patches/ink+7.0.6.patch` contains modifications to Ink 7.0.6, applied automatically via `patch-package` on `postinstall`. When modifying Ink-related code, always work on top of the existing patch — do not overwrite or revert the patch content. If further Ink changes are needed, append to `patches/ink+7.0.6.patch`.

## Conventions

- TypeScript strict mode, no explicit `any` unless unavoidable
- NodeNext modules — all imports use `.js` extensions
- React JSX via `react-jsx` (automatic runtime)
- Node built-in test runner (`node:test`), not Jest/Vitest
- Tests: unit tests, property-based tests (`*.property.test.ts` with fast-check), integration tests (`*.integration.test.ts`)
- Prefer small, behavior-preserving changes unless asked for a broader refactor

## Current ToolSearch Prompt State

ToolSearch prompt copy in `src/tools/ToolSearchTool/prompt.ts` uses plain ASCII
punctuation so deferred-tool instructions do not expose mojibake artifacts to
the model. `test/tools.test.ts` includes a regression check for this prompt
text.

### ToolSearch auto:N Threshold

`HANEKAWA_TOOL_SEARCH=auto:N` sets both the mode and threshold:
- `auto:0` -> always mode (0% threshold, always defer)
- `auto:100` -> off mode (100% threshold, never defer)
- `auto:N` (1-99) -> auto mode with N% as the threshold

Priority: `auto:N` over `HANEKAWA_TOOL_SEARCH_AUTO_PERCENT` env var over default 10%.

### ToolSearch Provider Support

Dynamic ToolSearch is provider-aware:
- Native Anthropic: deferred tools use `tool_reference` blocks with the `advanced-tool-use-2025-11-20` beta header.
- OpenAI and Anthropic-compatible proxy endpoints: dynamic ToolSearch is disabled and all business tool schemas are sent inline.
- `auto` mode enables dynamic loading only when deferred tool definitions, including input schemas, exceed the configured threshold.
- `alwaysLoad` tools are never announced as deferred.
- `HANEKAWA_DISABLE_EXPERIMENTAL_BETAS=1` disables beta-only dynamic ToolSearch payload fields.

## Environment Variables

- `MYAGENT_DEBUG_PROVIDER=1` — log provider request/response payloads
- `MYAGENT_PROMPT_CACHE_1H=1` — enable 1-hour Anthropic prompt cache TTL
- `MYAGENT_DISABLE_PROMPT_CACHING=1` — disable prompt caching
- `MYAGENT_MAX_OUTPUT_TOKENS=N` — override max output tokens (capped at 128k)
- `MYAGENT_SLOT_CAP_DISABLED=1` — disable the 8K output token slot cap (bypasses `CAPPED_DEFAULT_MAX_TOKENS`)
- `MYAGENT_STREAM_IDLE_TIMEOUT_MS=N` — stream idle timeout (default 90s)
- `MYAGENT_BASH_PATH` — override bash executable path (Windows)
- `MYAGENT_SUBAGENT_MODEL_<TYPE>` — override model for a specific subagent type
- `MYAGENT_SUBAGENT_MODEL` — override model for all subagent types
- `HANEKAWA_TOOL_SEARCH` - ToolSearch mode: `true`/`1`/unset=always, `false`/`0`=off, `auto`=auto, `auto:N`=auto with N% threshold
- `HANEKAWA_TOOL_SEARCH_AUTO_PERCENT` - auto mode threshold percentage (default 10); overridden by `auto:N`

## Current 1M Context Marker

Model keys can include an agent-side `[1m]` suffix, for example
`"mimo-v2.5[1m]"`, to mark a 1,000,000-token context window. The suffix is read
from the `models` map key only; the configured API `model` value is sent to the
provider unchanged and should not include provider-unsupported suffix text.

This marker takes precedence over built-in model capability table entries and
global `agent.contextManagement.contextWindow` defaults when Hanekawa computes
history selection, compaction thresholds, ToolSearch auto thresholds, status
display, and tool-result request budgets.
