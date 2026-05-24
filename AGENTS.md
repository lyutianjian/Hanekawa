# AGENTS.md

This file gives coding agents guidance when working in this repository.

## What This Is

Hanekawa (MyAgent) is a lightweight, self-hosted CLI programming agent. It supports Anthropic and OpenAI-compatible APIs, with session persistence, automatic context compaction, a skill system, MCP integration, prompt cache management, checkpoints, and permission-gated tools.

The interactive entrypoint is the Ink/React TUI at `src/tui/entrypoints/tui.tsx`.

## Commands

```bash
# Install dependencies (Node.js >= 22 required)
npm install

# Run the TUI (primary interactive mode)
bun run dev:tui          # new session
bun run dev:tui resume <id>  # resume session

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
| `/compact` | Force context compaction |

## Configuration

Config lives at `.myagent/config.json`:

```json
{
  "models": {
    "<name>": {
      "provider": "anthropic" | "openai",
      "model": "model-id",
      "apiKey": "sk-...",
      "baseUrl": "https://...",
      "promptCacheRetention": "in_memory" | "24h",
      "pricing": { "input": N, "output": N },
      "maxOutputTokens": N,
      "thinking": { "enabled": true, "budgetTokens": N }
    }
  },
  "defaultModel": "<name>",
  "agent": {
    "system": "custom system prompt",
    "sessionDir": ".myagent/sessions",
    "contextManagement": { ... }
  }
}
```

Settings merge in three tiers (lowest to highest priority):
1. `~/.myagent/settings.json` (user)
2. `.myagent/settings.json` (project)
3. `.myagent/settings.local.json` (local override)

Fields: `permissions` (allow/deny/ask glob patterns), `mcpServers`, `defaultModel`, `autoCompact`, `autoCompactThreshold`.

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
- `compact.ts` — token-driven auto-compaction via LLM summary
- `requestPrep.ts` — prepares session records, compacts oversized tool results (20k token limit per result), repairs tool_use/tool_result pairing
- `toolRunner.ts` — executes tool calls, records results, respects permission gates
- `permissions.ts` — three-tier risk model: `safe` (auto-allow), `confirm` (prompt user), `dangerous` (always prompt). Protected paths (`.git`, `.myagent`, `.env`, `.ssh`) and files (`.gitconfig`, `.bashrc`, `.env`, `.npmrc`) always blocked. Supports glob-pattern allow/deny rules.
- `cacheControl.ts` — Anthropic prompt caching breakpoints and cache break detection
- `cacheBreakDetection.ts` — tracks system prompt hash, tool schema hash, and model changes. Uses `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` to split static vs dynamic content.
- `usage.ts` — token counting and cost calculation (~3.5 chars/token ASCII, ~1.5 chars/token CJK)
- `commandAnalysis.ts` — shell command segmentation, complexity detection, protected-path analysis
- `toolValidation.ts` — JSON Schema validation for tool call inputs
- `diagnostics.ts` — runtime diagnostic formatting and TUI summarization
- `bashSafety.ts` — bash command safety analysis
- `hooks.ts` — lifecycle hooks
- `mediaStrip.ts` — media content stripping for context
- `metrics.ts` — runtime metrics collection
- `recordStream.ts` — session record streaming
- `sections.ts` — system prompt section management
- `toolApiSchema.ts` — tool API schema generation
- `types.ts` — shared type definitions (`Tool`, `ToolContext`, `ToolResult`, `ModelRequest`, etc.)

### Provider Layer (`src/config/providers/`)

Two providers share a common `ModelProvider` interface:

- `anthropicProvider.ts` — Anthropic SDK, streaming, cache break diagnostics
- `openaiProvider.ts` — OpenAI Chat Completions API with `prompt_cache_key` (SHA256 of model+system+tools)
- `anthropicPayload.ts` — Anthropic messages, tools, thinking, max token, and cache marker payload construction
- `openaiPayload.ts` — OpenAI messages, tools, and prompt_cache_key construction
- `registry.ts` — `ProviderRegistry` and `createProvider`
- `debug.ts` — provider debug logging
- `usage.ts` — usage normalization

Both support extended thinking/reasoning (`thinking: { enabled: true, budgetTokens: N }`). Anthropic uses `thinking`/`redacted_thinking` blocks; OpenAI uses `reasoning_content` field.

Max output tokens: default 32,000, upper limit 128,000 (env override or config). Auto-escalates to 64,000 on `max_tokens` stop reason with up to 3 recovery attempts.

Retry logic (`src/config/retry.ts`): exponential backoff with jitter (base 500ms, max 32s). Retries on HTTP 429, 529, 5xx, timeout, ECONNRESET, ECONNREFUSED.

### Prompt Cache Behavior

Native Anthropic requests can have cache markers on:
- the static system prompt block
- the final tool schema
- the final eligible message block

Dynamic system prompt content after `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` is not cache-marked. Third-party Anthropic-compatible payloads do not receive Anthropic-specific `cache_control` fields. OpenAI-compatible providers use `prompt_cache_key` instead.

### Context Items Model

The context system uses the `ModelContextItem` union: `ContextChatMessage`, `ContextToolUse`, `ContextToolResult`. Provider payload builders translate this neutral shape into Anthropic or OpenAI message formats.

### Tools (`src/tools/`)

Each tool exports a `Tool` object with `name`, `inputSchema` (JSON Schema), `riskLevel`, `isConcurrencySafe`, and an `execute` function. Safe tools run in parallel; unsafe tools run sequentially.

| Tool | Risk | Concurrency Safe | Notes |
|------|------|-----------------|-------|
| `Grep` | safe | yes | fast-glob, 50 match limit, skips dotfiles |
| `Glob` | safe | yes | |
| `Bash` | dangerous | no | 1MB output truncation, 30s timeout, Windows Git Bash detection |
| `Read` | safe | yes | LRU cache (100 entries) for post-compact restore |
| `Write` | confirm | no | |
| `Edit` | confirm | no | requires prior Read, exactly one match of oldString |
| `MultiEdit` | confirm | no | atomic exact string replacements |
| `Delete` | dangerous | no | |
| `TodoWrite` | safe | no | replaces the complete session todo list |
| `Skill` | safe | no | on-demand skill invocation, LRU eviction (50) |
| `Agent` | safe | no | typed subagent dispatch (`general`, `explore`, `plan`, `verification`) |

The `Skill` and `Agent` tools are dynamically created at runtime and not bundled in `getBuiltinTools()`.

#### Agent Sub-Agent Types

The `Agent` tool requires `subagent_type`:

- `general` - default-style read-only delegation for isolated research or focused questions. It inherits project context.
- `explore` - fast read-only codebase navigation using search/read tools. It omits project context to save tokens, so pass any critical conventions explicitly.
- `plan` - read-only implementation planning. It explores relevant code and returns a step-by-step plan plus critical files. It also omits project context.
- `verification` - adversarial verification after implementation work. It is strictly read-only for project files, may run read-only shell checks, and must end with `VERDICT: PASS`, `VERDICT: FAIL`, or `VERDICT: PARTIAL`.

Use `explore` before broad code searches, `plan` before larger or ambiguous changes, and `verification` before reporting completion on non-trivial implementation work.

Supporting modules: `fileState.ts` (file state tracking), `pathSafety.ts` (path safety checks).

### MCP Integration (`src/services/mcp/`)

Model Context Protocol support via `@modelcontextprotocol/sdk`. Currently `stdio` transport only.

- Config: `.myagent/mcp.json` (`{ mcpServers: Record<string, McpServerConfig> }`)
- Tools wrapped as `mcp__<serverName>__<toolName>`, default risk level `confirm`
- Can also be configured in settings files under `mcpServers`

### Skills (`src/services/skills/`)

Skills are `SKILL.md` files (YAML frontmatter with `name`+`description`, Markdown body) in `.myagent/skills/<name>/`. Auto-discovered at session start and injected into system prompt. The `Skill` tool allows on-demand invocation during conversation.

### Checkpoints (`src/services/checkpoint/`)

Shadow git repo per session under `.myagent/shadow-git/<session-id>/`. Creates commits on each assistant message, enabling rollback to any prior state via `git checkout <hash> -- .`. Windows-compatible (`core.symlinks=false`, `core.autocrlf=false`).

### Sessions (`src/sessions/`)

Sessions persist as JSONL records (atomic append) in `.myagent/sessions/`. Old JSON format auto-migrates. Record types: messages, tool_use, tool_result, tool_approval, compact_boundary. Title auto-assigned from first user message (60 chars). Supports prefix-based ID resolution and `truncateToMessage` for rollback.

- `service.ts` — session CRUD, JSONL append, prefix-based ID resolution
- `invariants.ts` — session record integrity checks and repair logic
- `recordStream.ts` — session record streaming

### TUI (`src/tui/`)

Ink/React-based terminal UI.

Components in `src/tui/components/`: `App`, `AssistantMessage`, `InputBox`, `Markdown`, `MessageList`, `Neko` (mascot), `PermissionDialog`, `RestoreMode`, `Spinner`, `StatusLine`, `StructuredDiff`, `ToolCallBlock`, `UserMessage`, `WelcomeBanner`.

Hooks in `src/tui/hooks/`: `useAgentLoop`, `useCommands`, `useInput`, `useKeyboardShortcuts`, `usePermission`, `useSpinner`.

Utils in `src/tui/utils/`: `doubleTapDetector` (chord-key timing detection for keybindings).

Additional TUI modules: `diff.ts`, `markdown.ts`, `theme.ts`, `types.ts`.

Permission prompts bridged via `createPromptProxy`/`createRecordProxy` connecting React state to the imperative permission gate.

### Prompts (`src/prompts/`)

System prompt composition: `composer.ts` (prompt assembly), `budget.ts` (token budget allocation).

### Project Context Discovery (`src/services/context/projectContext.ts`)

Walks up from cwd looking for `MYAGENT.md`, `CLAUDE.md`, `AGENTS.md`, plus `.myagent/rules/*.md` and local overrides (`MYAGENT.local.md`, `CLAUDE.local.md`). Cached within session.

## Context Management

- `contextWindow`: 200,000 tokens (default)
- `summaryOutputTokens`: 20,000 tokens (budget for compaction summary)
- Effective window = contextWindow - summaryOutputTokens
- Auto-compact triggers when tokens exceed effective window minus `autoCompactBufferTokens` (13,000)
- Token counting: ~3.5 chars/token ASCII, ~1.5 chars/token CJK
- Context item selection walks in reverse, repairs tool_use/tool_result pairing

## Environment Variables

- `MYAGENT_DEBUG_PROVIDER=1` — log full provider request/response payloads
- `MYAGENT_PROMPT_CACHE_1H=1` — enable 1-hour cache TTL (Anthropic)
- `MYAGENT_DISABLE_PROMPT_CACHING=1` — disable prompt caching globally
- `MYAGENT_DISABLE_PROMPT_CACHING_HAIKU=1` — disable prompt caching for Haiku models
- `MYAGENT_MAX_OUTPUT_TOKENS=N` — override max output tokens (capped at 128k)
- `MYAGENT_STREAM_IDLE_TIMEOUT_MS=N` — stream idle timeout (default 90s)

## Conventions

- TypeScript strict mode, no explicit `any` unless unavoidable
- NodeNext modules with `.js` import extensions
- React JSX through `react-jsx`
- Node built-in test runner (`node:test`), no external test framework
- Tests include unit tests, property-based tests (`*.property.test.ts` using fast-check), and integration tests (`*.integration.test.ts`)
- No build step for development — `tsx` handles execution directly
- Prefer small, behavior-preserving changes unless the user asks for a broader refactor
- Keep provider behavior covered by `test/config.test.ts`
