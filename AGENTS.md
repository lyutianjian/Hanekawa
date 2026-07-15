# AGENTS.md

This file gives coding agents guidance when working in this repository.

## What This Is

Hanekawa (MyAgent) is a self-hosted CLI General-Purpose agent. It supports Anthropic and OpenAI-compatible APIs, with session persistence, a persistent input queue, background shell/agent tasks, automatic context compaction, a skill system, MCP integration, prompt cache management, checkpoints, permission-gated tools, plan mode, lifecycle hooks, and deferred tool loading via ToolSearch.

The interactive entrypoint is the Ink/React TUI at `src/tui/entrypoints/tui.tsx`.

## Commands

```bash
# Install dependencies (Node.js >= 22 required)
bun install

# Run the TUI (primary interactive mode)
bun run dev:tui          # new session
bun run dev:tui resume <id>  # resume session
bun run dev:tui --continue   # continue most recent session
bun run dev:tui list         # list sessions

# Type checking
bun run typecheck        # tsc --noEmit

# Run all tests
bun run test

# Run a single test file
node --import tsx --test test/<file>.test.ts
```

No bundler — runs TypeScript directly via `tsx`.

### Slash Commands (inside TUI)

| Command | Description |
|---------|-------------|
| `/help` | Show available commands |
| `/clear` | Clear conversation history and reset cache diagnostics |
| `/cost` | Show token usage and cost |
| `/model [name]` | Show or set the current model |
| `/session` | Show current session info (ID, CWD) |
| `/skills` | List available skills with descriptions |
| `/<skill-name> [args]` | Run a disk skill as a normal query with skill frontmatter options when its name does not conflict with a built-in command |
| `/compact` | Force context compaction |
| `/agents reload` | Reload custom sub-agent definitions from `.myagent/agents*` |
| `/repair` | Repair the current session record stream and invalidate caches |
| `/provider [name]` | Show or set the active provider |
| `/plan` | Toggle plan mode |
| `/effort [level]` | Show or set reasoning effort level (low/medium/high/xhigh/max) |
| `/tasks` | Open the background shell/agent task panel |

## Configuration

Config lives at `.myagent/config.json`:

```json
{
  "endpoints": {
    "my-endpoint": {
      "provider": "anthropic",
      "baseUrl": "https://...",
      "apiKey": "sk-..."
    }
  },
  "models": {
    "<name>": {
      "provider": "anthropic" | "openai",
      "model": "model-id",
      "endpoint": "my-endpoint",
      "apiKey": "sk-...",
      "baseUrl": "https://...",
      "promptCacheRetention": "in_memory" | "24h",
      "pricing": { "input": N, "output": N },
      "maxOutputTokens": N,
      "thinking": { "type": "adaptive" | "enabled" | "disabled", "budgetTokens": N },
      "maxEffort": "low" | "medium" | "high" | "xhigh" | "max"
    }
  },
  "profiles": {
    "default": { "fast": "<model-key>", "balanced": "<model-key>", "powerful": "<model-key>" }
  },
  "routing": {
    "main": "balanced",
    "plan": "powerful",
    "compact": "fast",
    "subagent": { "general": "balanced", "explore": "fast", "plan": "powerful", "fork": "inherit" }
  },
  "defaultModel": "<name>",
  "fallbackModel": "<name>",
  "compactModel": "<name>",
  "agent": {
    "system": "custom system prompt",
    "sessionDir": ".myagent/sessions",
    "contextManagement": { "contextWindow": 200000, "summaryOutputTokens": 20000 },
    "agentTimeoutMs": 300000
  }
}
```

Settings merge in three tiers (lowest to highest priority):
1. `~/.myagent/settings.json` (user)
2. `.myagent/settings.json` (project)
3. `.myagent/settings.local.json` (local override)

Settings fields: `permissions` (mode + allow/deny/ask glob patterns), `autoMode` (allow/deny for auto mode classifier), `hooks` (lifecycle hook commands), `mcpServers`, `mcp.trustedServers`, `defaultModel`, `fallbackModel`, `compactModel`, `autoCompact`, `autoCompactThreshold`, `effortLevel`, `models`, `endpoints`, `profiles`, `routing`.

Keybindings config at `.myagent/keybindings.json`. Sections: `global`, `chat`, `editing`, `autocomplete`. Configurable `doubleTapWindow` (100-1000ms, default 300ms).

## Architecture

TypeScript (ES2022, NodeNext modules, JSX via react-jsx). Strict mode.

### Core Loop (`src/harness/`)

`AgentLoop` in `loop.ts` drives the reasoning cycle:

```
prepare records -> auto-compact if needed -> build context -> call model -> execute tools -> repeat
```

Key modules:

- `contextBuilder.ts` — assembles system prompt blocks, skills, environment info, post-compact restore context, and session history into a `ModelRequest`
- `compact.ts` — token-driven auto-compaction via LLM summary plus a 10k-token hard cap for any remaining oversized individual tool result
- `prompts/compactPrompt.ts` — structured compaction prompt and summary formatter
- `progressiveCompact.ts` — time-based and cache-edit-aware micro-compaction; conversation snipping has been removed
- `requestPrep.ts` — prepares session records, enforces the layered tool-result budget (see below), repairs tool_use/tool_result pairing
- `cacheEditManager.ts` — tracks Anthropic `cache_edits`, pending deletions, and pinned edits for cache-aware micro-compaction
- `toolRunner.ts` — executes tool calls, records results, respects permission gates
- `permissions.ts` — five permission modes: `default` (prompt for confirm/dangerous), `plan` (read-only + plan file writes), `acceptEdits` (auto-allow Edit/Write/MultiEdit + light shell), `auto` (classifier-based), `bypass` (auto-allow except protected paths and shell safety). Protected paths (`.git`, `.myagent`, `.env`, `.ssh`, `.aws`) and secret files (`.gitconfig`, `.bashrc`, `.env`, `.npmrc`, `id_rsa*`, `*.pem`, `*.key`, `*.p12`, `*.pfx`) always blocked. Supports glob-pattern allow/deny/ask rules. Denial streak escalation: after N consecutive auto-denials, forces user prompt.
- `autoClassifier.ts` — auto mode decision layers: safe-tool allowlist → acceptEdits fast-path → user rules → base classifier
- `cacheControl.ts` — Anthropic prompt caching breakpoints and cache break detection
- `cacheBreakDetection.ts` — tracks system prompt hash, tool schema hash, and model changes. Uses `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` to split static vs dynamic content.
- `usage.ts` — token counting and cost calculation (~3.5 chars/token ASCII, ~1.5 chars/token CJK)
- `commandAnalysis.ts` — shell command segmentation, complexity detection, protected-path analysis
- `bashSafety.ts` — bash command safety analysis
- `toolValidation.ts` — JSON Schema validation for tool call inputs
- `diagnostics.ts` — runtime diagnostic formatting and TUI summarization
- `hooks.ts` — lifecycle hooks: `userPromptSubmit`, `preToolUse`, `postToolUse`, `preCompact`, `postCompact`, `subagentStart`, `subagentStop`, `stop`. Hooks run shell commands with glob matchers, timeout (default 30s), and output size limits (200KB).
- `planModeManager.ts` — plan mode orchestration: enter/exit plan mode, plan file management, auto-allow plan file writes via permission gate
- `planModeAttachments.ts` — plan mode reminder injection
- `mediaStrip.ts` — media content stripping for context
- `metrics.ts` — runtime metrics collection
- `recordStream.ts` — session record streaming
- `sidechainRecordStream.ts` — background subagent transcript streaming
- `services/backgroundTasks/registry.ts` — session-scoped shell/agent task registry, lifecycle persistence, output ring buffers, and shutdown cleanup
- `sections.ts` — system prompt section management
- `systemReminder.ts` — unified `<system-reminder>` wrapper for dynamic context injection
- `toolApiSchema.ts` — tool API schema generation
- `toolUseSummary.ts` — async tool-use summarization for context compression
- `atMentions.ts` — `@file` reference parsing and context injection
- `types.ts` — shared type definitions (`Tool`, `ToolContext`, `ToolResult`, `ModelRequest`, etc.)

**Tool result budget — three layers:**

1. **Per-result write-time truncation** (`toolRunner.ts:applyToolResultBudget`): each tool defines `maxResultSizeChars`; content exceeding that limit is sliced at the boundary with a truncation notice. Current limits: Bash = 100k chars, Grep = 30k chars, Agent = 32k chars.
2. **Global request-time budget** (`requestPrep.ts`): total `tool_result` content across all records is capped at `effectiveContextWindow * 0.5` (floored at 200k tokens). When the budget is exceeded, older results are summarized, keeping the 10 most recent tool results intact.
3. **Per-result hard cap** (`compact.ts:snipLargeToolResults`): after global budgeting, any remaining individual tool result over 10k estimated tokens is replaced with a truncation notice. This does not remove conversation turns.

### Provider Layer (`src/config/providers/`)

Two providers share a common `ModelProvider` interface:

- `anthropicProvider.ts` — Anthropic SDK, streaming, cache break diagnostics
- `openaiProvider.ts` — OpenAI Chat Completions API with `prompt_cache_key` (SHA256 of model+system+tools)
- `anthropicPayload.ts` — Anthropic messages, tools, thinking, max token, cache marker payload construction, and cache edits injection (`pendingCacheEdits` into last user message, `pinnedCacheEdits` re-insertion with deduplication, `cache_reference` on cached-prefix tool_results)
- `openaiPayload.ts` — OpenAI messages, tools, and prompt_cache_key construction
- `registry.ts` — `ProviderRegistry` and `createProvider`
- `debug.ts` — provider debug logging
- `usage.ts` — usage normalization

Both support extended thinking/reasoning (`thinking: { type: 'adaptive' | 'enabled' | 'disabled' }`). Anthropic uses `thinking`/`redacted_thinking` blocks; OpenAI uses `reasoning_content` field.

Raw provider defaults are model-aware (32,000 for unknown modern models, upper limit 128,000), but normal Anthropic requests cap the default slot at 8,000 to avoid over-reservation. `MYAGENT_MAX_OUTPUT_TOKENS` or model config can override it; `MYAGENT_SLOT_CAP_DISABLED=1` restores the raw default. A `max_tokens` stop first escalates to 64,000, followed by up to 3 continuation attempts.

Retry logic (`src/config/retry.ts`): exponential backoff with jitter (base 500ms, max 32s). Per-category budgets: rate_limit(3), overload(2), server_error(3), transient(3). Retries on HTTP 429, 529, 5xx, timeout, ECONNRESET, ECONNREFUSED. Background callers skip 529 retries. `FallbackTriggeredError` triggers model fallback when overload budget exhausted.

### Model Routing (`src/config/routing.ts`)

Three-layer configuration:
- **Endpoints**: provider + baseUrl + apiKey
- **Models**: model id + reference to an endpoint (or legacy inline endpoint fields)
- **Profiles**: a tier → model-key mapping (fast / balanced / powerful)

Routing maps semantic roles to tiers: `main`, `plan`, `compact`, `subagent` (per subagent_type). Supports `'inherit'` sentinel for fork agents sharing parent prompt-cache. Default routing: main=balanced, plan=powerful, compact=fast.

### Prompt Cache Behavior

Native Anthropic requests can have cache markers on:
- the static system prompt block
- the final tool schema
- the final eligible message block

Dynamic system prompt content after `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` is not cache-marked. Third-party Anthropic-compatible payloads do not receive Anthropic-specific `cache_control` fields. OpenAI-compatible providers use `prompt_cache_key` instead.

### Context Items Model

The context system uses the `ModelContextItem` union: `ContextChatMessage`, `ContextToolUse`, `ContextToolResult`. Provider payload builders translate this neutral shape into Anthropic or OpenAI message formats.

### Tools (`src/tools/`)

Each tool exports a `Tool` object with `name`, `inputSchema` (JSON Schema via Zod), `riskLevel`, `isReadOnly`, `isDestructive`, `isConcurrencySafe`, and an `execute` function. Safe tools run in parallel; unsafe tools run sequentially.

| Tool | Risk | Read-Only | Destructive | Concurrency Safe | Notes |
|------|------|-----------|-------------|-----------------|-------|
| `Grep` | safe | yes | — | yes | fast-glob, 50 match limit, skips dotfiles |
| `Glob` | safe | yes | — | yes | |
| `Read` | safe | yes | — | yes | LRU cache (100 entries) for post-compact restore |
| `Bash` | dangerous | no | yes | no | foreground execution or `run_in_background`; 1MB output cap; Windows Git Bash detection |
| `BashOutput` | safe | yes | — | yes | consumes new output from a background shell; optional regex filter and wait up to 30s |
| `KillShell` | dangerous | no | yes | no | terminates a background shell and its child process tree |
| `Write` | confirm | no | — | no | |
| `Edit` | confirm | no | — | no | requires prior Read, exactly one match of oldString |
| `MultiEdit` | confirm | no | — | no | atomic exact string replacements |
| `Delete` | dangerous | no | yes | no | |
| `NotebookEdit` | confirm | no | — | no | Jupyter notebook cell editing |
| `WebFetch` | safe | yes | — | yes | URL → Markdown, 15min cache, 30s timeout, 100KB limit |
| `WebSearch` | safe | yes | — | yes | DuckDuckGo HTML search, no API key needed |
| `Config` | safe | no | — | no | read/write settings at runtime |
| `TaskCreate` | safe | no | — | no | creates a new task |
| `TaskList` | safe | yes | — | yes | lists all tasks |
| `TaskGet` | safe | yes | — | yes | gets a specific task |
| `TaskUpdate` | safe | no | — | no | updates a task |
| `ToolSearch` | safe | yes | — | yes | deferred tool schema loading via Anthropic tool_reference |
| `Skill` | safe | no | — | no | on-demand skill invocation, LRU eviction (50) |
| `Agent` | safe | — | — | input-specific | typed subagent dispatch; read-only agent types can run concurrently |

The `Skill` and `Agent` tools are dynamically created at runtime and not bundled in `getBuiltinTools()`. `ToolSearch` is added when `isToolSearchEnabled()` returns true.

#### Deferred Tool Loading (ToolSearch)

When ToolSearch is active, tools marked `shouldDefer` or `isMcp` are not included in the initial API tools array. The model discovers them via `ToolSearch`, which returns schemas as `tool_reference` content blocks. Discovered tool names survive compaction via `preCompactDiscoveredTools` on `compact_boundary` records.

#### Agent Sub-Agent Types

The `Agent` tool requires `subagent_type`. Built-in types:

- `general` — default-style read-only delegation for isolated research or focused questions. Inherits project context. Max 30 turns.
- `fork` — read-only fork that preloads the parent transcript and shares the parent fork prompt-cache stream. Max 200 turns. Recursion prevented (cannot spawn another fork).
- `explore` — fast read-only codebase navigation using Glob, Grep, Read only. Omits project context to save tokens. Max 30 turns. Effort=low.
- `plan` — read-only implementation planning using Glob, Grep, Read only. Omits project context. Max 30 turns. Effort=high.

Use `explore` before broad code searches and `plan` before larger or ambiguous changes.

Custom sub-agent types are loaded at TUI startup from Markdown files with YAML frontmatter:

```markdown
---
name: security-review
description: Adversarial security review against changes
tools: [Glob, Grep, Read, Bash]
omitProjectContext: false
isReadOnlyAgent: false
maxTurns: 15
maxResultSizeChars: 24000
permissionMode: auto
skills: [debugging]
mcpServers: [my-server]
background: false
isolation: worktree
model: powerful
effort: high
---

You are a security reviewer for Hanekawa. ...
```

Agent definition directories merge by `name` in this order, later files overriding earlier ones: `~/.myagent/agents/`, `.myagent/agents/`, `.myagent/agents.local/`. The Agent tool description is generated from the current definition table, and `subagent_type` is validated at runtime so unknown types produce a clear tool error. `/agents reload` refreshes these definitions without restarting the TUI.

Custom agents always disallow nested `Agent`, `EnterPlanMode`, `ExitPlanMode`, `AskUserQuestion` calls. `tools: ["*"]` means all read-only tools, while `Bash` is available only when explicitly listed. `isReadOnlyAgent` controls whether an agent type may be scheduled concurrently; definitions that list write-like tools such as `Bash`, `Write`, `Edit`, `MultiEdit`, `Delete`, or `TaskCreate`/`TaskUpdate` are treated as non-read-only even if they declare `isReadOnlyAgent: true`. Custom prompts have a 16k character soft warning threshold. Custom names that collide with built-ins, such as `explore`, override the built-in definition and produce a warning.

Background agents (`background: true` or `run_in_background: true`) return immediately and send a completion notification later. They use `SidechainRecordStream` for transcript persistence, default to `auto` permission mode, and register alongside background shells in the session task registry. `/tasks` displays both kinds; background shells are controlled through `BashOutput` and `KillShell`.

Worktree isolation (`isolation: 'worktree'`) creates an isolated git worktree for the sub-agent via `GitSubagentWorktreeManager`. Only available for non-read-only agents.

Environment variable overrides: `MYAGENT_SUBAGENT_MODEL_<TYPE>` (per-type) or `MYAGENT_SUBAGENT_MODEL` (generic).

Supporting modules: `fileState.ts` (file state tracking), `pathSafety.ts` (path safety checks), `agentDefinitionLoader.ts` (custom agent loading), `subagentWorktree.ts` (worktree isolation).

### MCP Integration (`src/services/mcp/`)

Model Context Protocol support via `@modelcontextprotocol/sdk`. Currently `stdio` transport only.

- Config: `.myagent/mcp.json` (`{ mcpServers: Record<string, McpServerConfig> }`)
- Tools wrapped as `mcp__<serverName>__<toolName>`, default risk level `confirm`
- Can also be configured in settings files under `mcpServers`
- MCP tools are deferred by default when ToolSearch is enabled (unless `alwaysLoad` is set)
- `mcp.trustedServers` in settings controls which MCP servers skip confirmation

### Skills (`src/services/skills/`)

Skills are `SKILL.md` files (YAML frontmatter with `name`+`description`, optional `allowedTools`, `model`, `effort`, `hooks`, and text `attachments`, plus a Markdown body) in `.myagent/skills/<name>/`. Auto-discovered at TUI startup and injected into system prompt. The `Skill` tool allows on-demand invocation during conversation, and each disk skill is also registered as a slash command named from its frontmatter when the name is not already used by a built-in command.

Skill slash commands submit the skill body as a normal query in the background while the TUI shows only the slash invocation, such as `/debugging args`. `$ARGUMENTS` placeholders are replaced with the slash command arguments; if no placeholder exists, non-empty arguments are appended as `Arguments: ...`. Inline shell snippets such as ``!`git status` `` run through the normal Bash tool permission gate before submission. Text attachments are UTF-8 files resolved inside the skill directory and appended to the prompt. `allowedTools` limits model-visible and executable tools, while `model` and `effort` are temporary per-turn overrides. Skill hooks merge with session hooks for only the active skill turn. Built-in slash commands take precedence on name conflicts, and new or changed skill commands require restarting the TUI. Image/PDF multimodal attachments are not supported in this stage.

### Checkpoints (`src/services/checkpoint/`)

Shadow git repo per session under `.myagent/shadow-git/<session-id>/`. Creates commits on each assistant message, enabling rollback to any prior state via `git checkout <hash> -- .`. Windows-compatible (`core.symlinks=false`, `core.autocrlf=false`).

### Sessions (`src/sessions/`)

Sessions persist as JSONL records (atomic append) in `.myagent/sessions/`. Old JSON format auto-migrates. Record types include messages, tool uses/results/approvals, compaction records, tool-use summaries, subagent transcripts/tasks, background tasks, message-queue operations, plan-mode outcomes, turn interruptions, and `@file` context. Title auto-assigned from first user message (60 chars). Supports prefix-based ID resolution and `truncateToMessage` for rollback.

- `service.ts` — session CRUD, JSONL append, prefix-based ID resolution
- `invariants.ts` — session record integrity checks and repair logic
- `recordStream.ts` — session record streaming

### TUI (`src/tui/`)

Ink/React-based terminal UI.

Components in `src/tui/components/`: `App`, `AssistantMessage`, `AssistantThinkingMessage`, `InputBox`, `Markdown`, `MessageList`, `Neko` (mascot), `PermissionDialog`, `RestoreMode`, `Spinner`, `StatusLine`, `StructuredDiff`, `ToolCallBlock`, `UserMessage`, `WelcomeBanner`, `CollapsedToolGroup`, `CommandSuggestions`, `ProviderPanel`, `ModelPickerDialog`, `EffortPickerBar`, `EnterPlanModeDialog`, `ExitPlanModeDialog`, `AskUserQuestionDialog`, `SubagentTaskBlock`, `TaskListBlock`, `BackgroundTasksPanel`, `TranscriptView`, `AlternateScreen`, `ResponseBlock`.

`messageQueue.ts` persists enqueue/dequeue/clear operations in the active session so users can submit while the model is streaming. The queue is replayed on resume, migrated on `/clear`, and drained serially when the TUI becomes idle. A double Escape clears pending messages while work is active.

Hooks in `src/tui/hooks/`: `useAgentLoop`, `useCommands`, `useInput`, `useKeyboardShortcuts`, `usePermission`, `useSpinner`, `useBlink`, `useAskUserQuestionPermission`, `useEnterPlanPermission`, `useExitPlanPermission`.

Utils in `src/tui/utils/`: `doubleTapDetector` (chord-key timing detection for keybindings), `toolGroupSummary`.

Additional TUI modules: `diff.ts`, `markdown.ts`, `theme.ts`, `types.ts`, `ansi.tsx`, `layout.ts`, `transcript.ts`, `cursorParking.ts`, `permissionMode.ts`, `interruptRollback.ts`, `rewindSummary.ts`, `statusUsage.ts`, `fileToolPreview.ts`, `ink.tsx`.

Permission prompts bridged via `createPromptProxy`/`createRecordProxy` connecting React state to the imperative permission gate.

### Prompts (`src/prompts/`)

System prompt composition: `composer.ts` (prompt assembly), `budget.ts` (token budget allocation).

### Project Context Discovery (`src/services/context/projectContext.ts`)

Walks up from cwd looking for `MYAGENT.md`, `CLAUDE.md`, `AGENTS.md`, plus `.myagent/rules/*.md` and local overrides (`MYAGENT.local.md`, `CLAUDE.local.md`). Cached within session.

## Context Management

- `contextWindow`: 200,000 tokens (default)
- `summaryOutputTokens`: 20,000 tokens (budget for compaction summary)
- Effective window = contextWindow - summaryOutputTokens
- Ratio-based micro-compaction triggers at 90% of the effective window (`microCompactThresholdRatio = 0.9`) only when `cache_edits` are supported; providers without cache-edit support skip this step to preserve prompt-cache prefix stability.
- Auto-compact triggers when tokens exceed effective window minus `autoCompactBufferTokens` (13,000)
- Conversation snipping has been removed; Hanekawa does not remove middle turns by position-only truncation.
- Token counting: ~3.5 chars/token ASCII, ~1.5 chars/token CJK
- Context item selection walks in reverse, repairs tool_use/tool_result pairing

## Environment Variables

- `MYAGENT_DEBUG_PROVIDER=1` — log full provider request/response payloads
- `MYAGENT_PROMPT_CACHE_1H=1` — enable 1-hour cache TTL (Anthropic)
- `MYAGENT_DISABLE_PROMPT_CACHING=1` — disable prompt caching globally
- `MYAGENT_DISABLE_PROMPT_CACHING_HAIKU=1` — disable prompt caching for Haiku models
- `MYAGENT_MAX_OUTPUT_TOKENS=N` — override max output tokens (capped at 128k)
- `MYAGENT_SLOT_CAP_DISABLED=1` — disable the normal 8k default output-slot cap
- `MYAGENT_STREAM_IDLE_TIMEOUT_MS=N` — stream idle timeout (default 90s)
- `MYAGENT_BASH_PATH` — override bash executable path (Windows)
- `MYAGENT_SUBAGENT_MODEL_<TYPE>` — override model for a specific subagent type
- `MYAGENT_SUBAGENT_MODEL` — override model for all subagent types
- `HANEKAWA_SEARCH_URL` — use a SearXNG instance instead of DuckDuckGo HTML search
- `HANEKAWA_TOOL_SEARCH` — `always`/`true`/`1`, `off`/`false`/`0`, `auto`, or `auto:N` deferred-tool mode
- `HANEKAWA_TOOL_SEARCH_AUTO_PERCENT=N` — ToolSearch auto-mode threshold (default 10%; overridden by `auto:N`)
- `HANEKAWA_DISABLE_EXPERIMENTAL_BETAS=1` — omit beta-only dynamic ToolSearch payload fields

Model configuration keys may end in an agent-side `[1m]` suffix to force a 1,000,000-token context window without changing the API model ID. This override feeds history selection, compaction thresholds, ToolSearch thresholds, status display, and tool-result budgets.

## Conventions

- TypeScript strict mode, no explicit `any` unless unavoidable
- NodeNext modules with `.js` import extensions
- React JSX through `react-jsx`
- Node built-in test runner (`node:test`), no external test framework
- Tests include unit tests, property-based tests (`*.property.test.ts` using fast-check), and integration tests (`*.integration.test.ts`)
- No build step for development — `tsx` handles execution directly
- Prefer small, behavior-preserving changes unless the user asks for a broader refactor
- Keep provider behavior covered by `test/config.test.ts`
