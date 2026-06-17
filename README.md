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

Tool status rows, collapsed tool-group rows, and subagent task rows render flush
with the assistant message gutter. Nested tool output still uses the response
prefix indentation. Successful tool and subagent `●` prefixes use
`rgb(78,186,101)`; failed prefixes use `rgb(255,107,128)`.

Agent/subagent rows use compact task summaries in the header. Completed rows
show the routed model, tool-use count, token usage, and duration; Ctrl+O expands
them to show only the user task as `Prompt` and the subagent output as
`Response`, never the full internal agent system prompt.

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

Default context management reserves 20,000 tokens for compact summaries, starts
ratio-based micro-compaction at 90% of the effective window only when
`cache_edits` are available, starts auto-compaction near the effective-window
limit, and no longer includes middle conversation snipping, so historical turns
are not removed by position-only truncation.

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
allowedTools: [Read, Grep, Bash]
model: powerful
effort: high
attachments:
  - references/checklist.md
hooks:
  stop:
    - command: "echo skill finished"
---

Skill instructions go here. Use $ARGUMENTS where slash command arguments should appear.
```

Skills are discovered at TUI startup and made available in two ways:

- the generic `Skill` tool, which lets the model load a named skill during a turn
- slash commands named from the skill frontmatter, such as `/debugging args`

Skill slash commands submit the skill body as a normal query in the background
while the TUI shows only the slash invocation, such as `/debugging args`.
`$ARGUMENTS` in the skill body is replaced with the slash command arguments;
when no placeholder is present, non-empty arguments are appended as
`Arguments: ...`. Skill bodies may include inline shell snippets like
``!`git status` ``; these run through the normal Bash tool permission gate
before the query is submitted.

Slash skills can also declare text `attachments`, `hooks`, `allowedTools`,
`model`, and `effort` in frontmatter. These options apply only to that skill
turn: `allowedTools` filters the model-visible and executable tool set, `model`
and `effort` are temporary overrides, and hooks are merged with the session
hooks for that turn. Attachment paths are UTF-8 text files resolved inside the
skill directory and appended to the prompt. Built-in slash commands take
precedence when names conflict. New or changed skill commands require restarting
the TUI. Image/PDF multimodal attachments are not supported in this stage.

### Sessions

Sessions are stored in `.myagent/sessions/` as metadata plus JSONL records. Records include messages, tool uses, tool results, approvals, and compact boundaries.

## Useful Environment Variables

- `MYAGENT_DEBUG_PROVIDER=1`: log provider request and response payloads
- `MYAGENT_PROMPT_CACHE_1H=1`: enable 1-hour Anthropic prompt cache TTL
- `MYAGENT_DISABLE_PROMPT_CACHING=1`: disable prompt caching
- `MYAGENT_MAX_OUTPUT_TOKENS=N`: override max output tokens
- `MYAGENT_STREAM_IDLE_TIMEOUT_MS=N`: override Anthropic stream idle timeout

## Current ToolSearch Prompt State

ToolSearch prompt copy in `src/tools/ToolSearchTool/prompt.ts` uses plain ASCII
punctuation so deferred-tool instructions do not expose mojibake artifacts to
the model. `test/tools.test.ts` includes a regression check for this prompt
text.

### ToolSearch Configuration

- `HANEKAWA_TOOL_SEARCH` - mode: `true`/`1`/unset=always, `false`/`0`=off, `auto`=auto, `auto:N`=auto with N% threshold
- `HANEKAWA_TOOL_SEARCH_AUTO_PERCENT` - auto mode threshold percentage (default 10)
- `auto:N` takes priority over `HANEKAWA_TOOL_SEARCH_AUTO_PERCENT`
- `HANEKAWA_DISABLE_EXPERIMENTAL_BETAS=1` disables beta-only dynamic ToolSearch payload fields

Dynamic ToolSearch is enabled only for native Anthropic providers that support `tool_reference`, using the `advanced-tool-use-2025-11-20` beta header. OpenAI and Anthropic-compatible proxy endpoints fall back to complete inline tool schemas instead of dynamic loading.

## 1M Context Model Keys

Model names in the `models` map are Hanekawa-side keys. Add a `[1m]` suffix to
that key when the configured provider model should be treated as having a
1,000,000-token context window:

```json
{
  "models": {
    "mimo-v2.5[1m]": {
      "endpoint": "xiaomi",
      "model": "mimo-v2.5"
    }
  }
}
```

The suffix is not sent to the API; only the `model` field is used for provider
requests. Hanekawa uses the key suffix for context budgeting, history selection,
compaction thresholds, and status display.
