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

Create `~/.myagent/config.json` to configure models once for every project:

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

A project can override any of this by creating `.myagent/config.json` in its own root; the two are
merged key by key, with the project file winning. Model changes made from the TUI are written back to
whichever of the two files applies — the project one if it exists, otherwise the global one.

### Project instructions

Hanekawa reads the project's own instructions into every prompt. Starting at the working directory and
walking up to the filesystem root, it collects:

- `CLAUDE.md`, or `AGENTS.md` if there is no `CLAUDE.md`
- every `*.md` under `.myagent/rules/`

then, from the working directory only, `CLAUDE.local.md` — or `AGENTS.local.md` if that one is absent.
Keep the local file out of version control for personal notes.

Each directory contributes **one** of the two instruction files, not both: repositories that keep
`AGENTS.md` and `CLAUDE.md` in sync would otherwise send the same guide twice in every request. Files
are read outermost first, so the nearest one wins, and the local file is read last of all.

The set is read once when a project opens and captured when a session's runtime is built, the same way
hooks are. Editing one of these files mid-session takes effect on the next settings reload — saving
anything on the desktop settings screen does one, and it rebuilds the runtime when the instructions
changed. In the TUI, restart to pick up an edit.

### Routing

`routing` sends a particular role to a particular model. Every value is a key from `models`, or
`"inherit"` to follow the main loop's model:

```json
{
  "routing": {
    "main": "inherit",
    "plan": "claude",
    "compact": "openai-compatible",
    "subagent": {
      "general": "inherit",
      "explore": "openai-compatible"
    }
  }
}
```

A `subagent` type with no entry of its own falls back to `subagent.general`, then to `inherit`.
Everything defaults to `inherit`, so a one-model setup needs no `routing` block at all.

> **Breaking change.** The `fast` / `balanced` / `powerful` tiers and the `profiles` layer that mapped
> them to models are gone; `routing` names model keys directly. A config still using them starts
> normally and prints a warning: tier-valued `routing` entries are read as `"inherit"`, and a
> `defaultModel` naming a tier falls back to the first model that resolves. Two behaviors went away
> with the tiers — plan mode no longer upgrades the model automatically, and compaction no longer
> downgrades it. Set `routing.plan` / `routing.compact` (or the standalone `compactModel`) to get
> either back.

The `.myagent/` directory is also where sessions, skills, and local runtime state are stored. Those
stay per-project: only `config.json` and `settings.json` have a `~/.myagent/` counterpart.

### Thinking

Extended thinking is on by default: requests carry the provider's adaptive thinking config, and
`/effort <low|medium|high|xhigh|max>` tunes how much of it the model spends.

`/thinking off` turns it off — requests then carry no `thinking` parameter at all — and `/thinking on`
turns it back on. Either form writes `thinking` to `<project>/.myagent/settings.local.json` and applies
to the session you are in; the desktop settings screen has the same switch under 通用 › 扩展思考. The
switch is read when a runtime is built, so it also covers subagents.

```json
{ "thinking": false }
```

### The desktop settings screen

The desktop app has a settings screen (`⚙ 设置` at the bottom of the sidebar, or Ctrl+,) covering the
same configuration. Which file each page writes is not uniform, and the screen names the file it is
about to change:

| Page | Writes |
|---|---|
| Models and providers, subagent routing, context management | `config.json` (the project one if it exists, else `~/.myagent/config.json`) |
| Permission rules, startup permission mode, extended thinking, prompt-cache TTL, MCP trust | `<project>/.myagent/settings.local.json` |

Two consequences worth knowing:

- Permission rules **concatenate** across settings layers and MCP trust is **unioned**, so the screen can
  only edit the entries in `settings.local.json`. Rules inherited from `~/.myagent/settings.json` or the
  project's `settings.json` are listed as read-only, and a trust granted in one of those files cannot be
  revoked from the screen — remove it there.
- The six context-management numbers are read once when a project starts, so changing them takes effect
  after a restart. Everything else on the screen applies to open sessions immediately.

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

### Desktop smoke run (the real app, real credentials)

`npm test` never launches Electron: it is offline and hermetic, and worth keeping that
way. The desktop shell is therefore verified by a separate driver that launches the real
app, drives it over the Chrome DevTools Protocol, and checks what only a running window
can show — that a background session keeps streaming, that a parked permission prompt
survives a session switch, that deleting a session removes every artifact, that the
settings screen persists across a restart.

```bash
npm run build:desktop      # it refuses to run against a stale dist/
npm run smoke:desktop
```

It needs a display and a working provider, so it is a local check rather than a CI one.

- **It does not touch your data.** The app is pointed at scratch projects in the OS temp
  directory, seeded from `~/.myagent/config.json`; the repository's own `.myagent/` is
  never the project it has open. Four assertions afterwards confirm that your session
  index, your session files, `~/.myagent/config.json` and `~/.myagent/settings.json` were
  all left untouched. The seeded copy contains your API keys, so it is written `0600` and
  the scratch directory is deleted when the run finishes (`--keep` retains it, and the
  summary always prints the path).
- **It spends nothing by default.** One item — a live turn continuing in the background —
  needs a real model turn, and it only runs with `--paid-turn`. That turn is capped by a
  one-shot latch, pinned to the cheapest configured model, and interrupted if it overruns.
- Screenshots, logs and a summary land in `.smoke/<timestamp>/` (gitignored). The summary
  ends with a list of what to look at in each screenshot: category layout, control
  alignment, how the switches read — the judgements no assertion can make.

Useful flags: `--only=S3,S8` to run named steps, `--verbose` to print passing assertions,
`--kill-stale` when a previous Electron is still holding the single-instance lock,
`--model=<key>` and `--paid-prompt=<text>` for the paid turn.

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

Anthropic prompt caching defaults to `auto` on every Anthropic-compatible endpoint,
including proxies. Requests use the same cache markers regardless of the endpoint's hostname:

- the static system prompt block
- the final tool schema
- the final eligible message block

If an endpoint explicitly rejects prompt caching or `cache_control` with HTTP 400/422,
Hanekawa retries that request once without cache markers. Only a successful uncached
retry records the rejection, shared by all provider instances in the process for
the same endpoint URL and model. New sessions, model switches, and subagents reuse
that result; restarting the process clears it. Concurrent requests made before the
result is recorded may each probe and fall back independently. Unrelated errors use
the normal retry policy; zero cache hits do not disable caching.

Set `promptCaching` to `"auto"`, `"on"` (no compatibility fallback), or `"off"` on an
endpoint or model in `~/.myagent/config.json`. Model values override endpoint defaults.
`"on"` sends cache markers even if a rejection was previously recorded.
`MYAGENT_DISABLE_PROMPT_CACHING=1` disables Anthropic cache markers regardless of this
setting.

The existing 5-minute/1-hour TTL settings apply to compatible endpoints too; ordinary
caching does not send beta headers. Cache usage and cache-break diagnostics also run
on compatible endpoints. Missing cache usage is not treated as a zero hit; provider
debug output reports uncached input, cache creation, and cache reads separately.

OpenAI-compatible requests use a stable `prompt_cache_key` based on model, system prompt, and tools.

Context management stays client-side: Hanekawa does not send `context_management`
or `cache_edits` requests. It reserves 20,000 tokens for compact summaries, preserves
active conversation prefixes, clears old tool results after a long idle gap, and
starts auto-compaction near the effective-window limit. Historical turns are not
removed by position-only truncation.

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

### Rewind

`/rewind` steps back to an earlier prompt. It can restore the conversation, the
code, or both.

Restoring code restores **only the files the agent's write tools changed**
(`Edit`, `Write`, `MultiEdit`, `NotebookEdit`, `Delete`). Before each such write
the previous contents are copied to `~/.myagent/file-history/<session-id>/`, and
a rewind puts those copies back — deleting files the agent created after the
chosen point.

`Bash` is covered only where the target is unambiguous from the command text:
output redirections (`> f`, `>> f`, `2> f`, `&> f`), `tee`, and non-recursive
`cp`/`mv`. A command that builds its target with a variable, a glob, or a
command substitution, and anything a script writes indirectly, is not captured.

Everything else is left exactly as it is: your own edits in an editor, build
output, and `git` operations are never captured and never rolled back. A rewind
undoes the agent's edits, not the state of your worktree.

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

## Model Context Windows

Set `contextWindow` explicitly on a model when its provider supports a context
window other than the default 200,000 tokens:

```json
{
  "models": {
    "mimo-v2.5": {
      "endpoint": "xiaomi",
      "model": "mimo-v2.5",
      "contextWindow": 1000000
    }
  }
}
```

When omitted, Hanekawa uses 200,000. The configured value controls context
budgeting, history selection, compaction thresholds, ToolSearch thresholds, and
status display; Hanekawa does not infer it from the model name.

### The 1M context beta header

Anthropic's 1M context window is a **request header**, not part of the model id:
`anthropic-beta: context-1m-2025-08-07`. Some Anthropic-compatible endpoints only
serve their 1M models when it is present, while vendors that are already 1M by
default may reject an unrecognized beta. So it is an explicit per-model switch,
off by default — `longContext1m` in config, or 「1M 上下文请求头」 in the desktop
settings screen's model form:

```json
{
  "models": {
    "sonnet-1m": {
      "endpoint": "proxy",
      "model": "claude-sonnet-4-6",
      "contextWindow": 1000000,
      "longContext1m": true
    }
  }
}
```

The two fields are **orthogonal and both usually wanted**: `longContext1m` only
adds the header, `contextWindow` is the local token budget. Setting one does not
change the other. The switch is read by the `anthropic` provider only, and —
unlike every other beta Hanekawa sends — it applies to custom `baseUrl` endpoints
too, since those are exactly the ones that need it.
