# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Hanekawa (MyAgent) is a self-hosted CLI programming agent for the terminal. TypeScript (ES2022, strict mode, NodeNext modules), Ink/React TUI, supports Anthropic and OpenAI-compatible APIs. Features: session persistence, automatic context compaction, skills, MCP integration, prompt cache management, checkpoints, and permission-gated tools.

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

- **`ContextBuilder`** (`contextBuilder.ts`) — assembles system prompt, skills, environment, session history into `ModelRequest`
- **`ToolRunner`** (`toolRunner.ts`) — executes tool calls with ordered batching (safe tools parallel, unsafe sequential), records results, enforces per-result size budgets
- **`PermissionGate`** (`permissions.ts`) — three-tier risk model: `safe` (auto-allow), `confirm` (prompt), `dangerous` (always prompt). Protected paths (`.git`, `.myagent`, `.env`, `.ssh`) always blocked.
- **`compact.ts`** — token-driven auto-compaction via LLM summary when context exceeds threshold

### Providers (`src/config/providers/`)

Two providers share a `ModelProvider` interface: `anthropicProvider.ts` (Anthropic SDK, streaming, cache diagnostics) and `openaiProvider.ts` (OpenAI Chat Completions with `prompt_cache_key`). Both support extended thinking/reasoning. Payload builders translate a neutral `ModelContextItem` union into provider-specific formats.

### Tools (`src/tools/`)

Each tool exports `{ name, inputSchema (Zod), riskLevel, isConcurrencySafe, execute() }`. Safe tools (Grep, Glob, Read) run in parallel; confirm/dangerous tools (Write, Edit, Bash, Delete) run sequentially. The `Agent` and `Skill` tools are created dynamically at runtime.

### Configuration

Three-tier settings merge (lowest → highest priority):
1. `~/.myagent/settings.json` (user)
2. `.myagent/settings.json` (project)
3. `.myagent/settings.local.json` (local override)

Model config at `.myagent/config.json` — endpoints, models, profiles (fast/balanced/powerful), routing (main/plan/compact/subagent).

### Sessions (`src/sessions/`)

JSONL records in `.myagent/sessions/`. Record types: messages, tool_use, tool_result, tool_approval, compact_boundary, subagent_transcript. Prefix-based ID resolution.

### Skills (`.myagent/skills/<name>/SKILL.md`)

Markdown files with YAML frontmatter (`name`, `description`). Auto-discovered at startup, injected into system prompt, invocable via the `Skill` tool.

### Sub-Agents

Built-in types: `general` (delegation), `fork` (transcript preload), `explore` (read-only search, omits project context), `plan` (read-only planning). Custom types from `.myagent/agents/*.md` with YAML frontmatter.

### MCP Integration

Model Context Protocol via `@modelcontextprotocol/sdk` (stdio transport). Config at `.myagent/mcp.json`. Tools wrapped as `mcp__<serverName>__<toolName>`.

## Ink Patch

The current branch uses a customized Ink build. `patches/ink+7.0.5.patch` contains modifications to Ink 7.0.5, applied automatically via `patch-package` on `postinstall`. When modifying Ink-related code, always work on top of the existing patch — do not overwrite or revert the patch content. If further Ink changes are needed, append to `patches/ink+7.0.5.patch`.

## Conventions

- TypeScript strict mode, no explicit `any` unless unavoidable
- NodeNext modules — all imports use `.js` extensions
- React JSX via `react-jsx` (automatic runtime)
- Node built-in test runner (`node:test`), not Jest/Vitest
- Tests: unit tests, property-based tests (`*.property.test.ts` with fast-check), integration tests (`*.integration.test.ts`)
- Tool result budgets: per-result truncation (Bash=100k, Grep=30k, Agent=32k chars) and global request-time cap at 50% of context window

## Environment Variables

- `MYAGENT_DEBUG_PROVIDER=1` — log provider request/response payloads
- `MYAGENT_PROMPT_CACHE_1H=1` — enable 1-hour Anthropic prompt cache TTL
- `MYAGENT_DISABLE_PROMPT_CACHING=1` — disable prompt caching
- `MYAGENT_MAX_OUTPUT_TOKENS=N` — override max output tokens (capped at 128k)
- `MYAGENT_STREAM_IDLE_TIMEOUT_MS=N` — stream idle timeout (default 90s)
