# Hanekawa / MyAgent

Hanekawa, also called MyAgent, is a lightweight self-hosted programming agent for the terminal. It supports Anthropic and OpenAI-compatible APIs, session persistence, automatic context compaction, skills, permission-gated tools, and an Ink-based TUI.

## Requirements

- Node.js 22 or newer
- Bun or npm
- An Anthropic API key, or an OpenAI-compatible API key

## Install

```bash
bun install
```

Or:

```bash
npm install
```

## Configure

Create `.myagent/config.json` in the repository root:

```json
{
  "models": {
    "claude": {
      "provider": "anthropic",
      "model": "claude-sonnet-4-20250514",
      "apiKey": "sk-ant-..."
    },
    "openai-compatible": {
      "provider": "openai",
      "model": "deepseek-chat",
      "apiKey": "sk-...",
      "baseUrl": "https://api.deepseek.com/v1"
    }
  },
  "defaultModel": "claude",
  "fallbackModel": "openai-compatible",
  "agent": {
    "system": "You are Hanekawa, a CLI programming assistant."
  }
}
```

The `.myagent/` directory is also where sessions, skills, and local runtime state are stored.

## Start

Use the TUI for the interactive agent experience:

```bash
bun run dev:tui
```

Transcript history opens with Ctrl+O in a terminal alternate screen. While that
view is active, the app enables xterm alternate-scroll mode so mouse-wheel input
can map to the same up/down scrolling path as the arrow keys. It also enables
SGR mouse wheel reporting as a fallback for terminals that do not implement
alternate-scroll mapping; the terminal's native scrollbar may still be hidden by
the alternate screen.

Resume a session:

```bash
bun run dev:tui resume <session-id-or-prefix>
```

Continue the most recent session:

```bash
bun run dev:tui --continue
bun run dev:tui c
```

List sessions:

```bash
bun run dev:tui list
```

## Test

Run all tests:

```bash
bun run test
```

Run type checking:

```bash
bun run typecheck
```

Run one or more test files:

```bash
node --import tsx --test test/config.test.ts
node --import tsx --test test/config.test.ts test/cacheBreakDetection.test.ts
```

## Architecture

### Agent Loop

`src/harness/loop.ts` drives the main reasoning cycle:

```text
user input -> prepare records -> compact if needed -> build context -> call model -> run tools -> repeat
```

The loop keeps the current Promise-based architecture. Tool execution uses ordered batching: consecutive concurrency-safe tools run in parallel, while unsafe tools run one at a time as ordering barriers. `ToolRunner` owns tool-use, approval, and tool-result records.

### Context And Cache

`src/harness/contextBuilder.ts` assembles:

- static system instructions
- project context
- optional custom system text
- skills
- environment metadata
- current date
- post-compact restore context
- session history

Anthropic prompt caching is managed by `src/harness/cacheControl.ts` and provider payload builders. Native Anthropic requests can have cache markers on:

- the static system prompt block
- the final tool schema
- the final eligible message block

OpenAI-compatible requests use a stable `prompt_cache_key` based on model, system prompt, and tools.

### Providers

Provider code is split under `src/config/providers/`:

- `anthropicProvider.ts`
- `openaiProvider.ts`
- `anthropicPayload.ts`
- `openaiPayload.ts`
- `usage.ts`
- `debug.ts`
- `registry.ts`

The compatibility entrypoint remains `src/config/providers.ts`, so existing imports from `../config/providers.js` continue to work.

### Tools

Built-in tools live in `src/tools/`. Each tool declares:

- `name`
- `description`
- `inputSchema`
- `riskLevel`
- optional `isConcurrencySafe`
- `execute()`

Permission levels are `safe`, `confirm`, and `dangerous`.

### Skills

Skills live in `.myagent/skills/<name>/SKILL.md` with YAML frontmatter:

```markdown
---
name: debugging
description: Use when diagnosing bugs
---

Skill instructions go here.
```

Skills are discovered at startup and made available through the generic `Skill` tool.

### Sessions

Sessions are stored in `.myagent/sessions/` as metadata plus JSONL records. Records include messages, tool uses, tool results, approvals, and compact boundaries.

## Useful Environment Variables

- `MYAGENT_DEBUG_PROVIDER=1`: log provider request and response payloads
- `MYAGENT_PROMPT_CACHE_1H=1`: enable 1-hour Anthropic prompt cache TTL
- `MYAGENT_DISABLE_PROMPT_CACHING=1`: disable prompt caching
- `MYAGENT_MAX_OUTPUT_TOKENS=N`: override max output tokens
- `MYAGENT_STREAM_IDLE_TIMEOUT_MS=N`: override Anthropic stream idle timeout
