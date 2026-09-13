# Hanekawa / MyAgent

Hanekawa, also called MyAgent, is a lightweight self-hosted programming agent for the terminal. It supports Anthropic and OpenAI-compatible APIs, session persistence, automatic context compaction, skills, permission-gated tools, image input, and an Ink-based TUI.

## Requirements

- Node.js 22 or newer
- Bun or npm
- An Anthropic or OpenAI-compatible API key to use a model; startup and configuration do not require one

## Install

```bash
bun install
```

Or:

```bash
npm install
```

## Configure

Start the desktop (`npm run build:desktop`, then `npm run start:desktop`) or the TUI
(`npm run dev:tui`). When no usable default model is configured, the app opens its
existing configuration screen automatically: **模型与服务商** on desktop, or
**/provider** in the TUI. You can close it to view sessions and history, and reopen
it from the desktop's **配置模型** control or the `/provider` command.

Add an endpoint with its provider, API key and optional Base URL, then add a model
using that endpoint and the provider's model ID. Saving the endpoint before adding
a model is supported. The first resolvable model you save becomes the default when
no default has been selected. Configuration takes effect without restarting; all
open projects receive global provider changes, with running turns finishing before
their runtime is replaced. Removing the last model returns the app to configuration
state. An attempted message before setup keeps its draft and attachments.

The app creates and saves `~/.myagent/config.json` for all projects. A missing model,
broken model reference or incomplete provider configuration leaves setup available.
Startup does not test network connectivity or remote authentication; request errors
are reported when a model is used.

You can also edit `~/.myagent/config.json` manually:

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

`config.json` is global only. Legacy project `.myagent/config.json` files are migrated
into the global configuration and archived on first load. Settings such as permissions
and MCP trust continue to support project-specific layers.

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

Not every model takes every level, and some endpoints reject an unsupported one outright rather than
rounding it down. `supportedEfforts` names the levels a model accepts — 思考等级 in the desktop
settings screen's model form, where it is a checklist. Absent means all five. A level outside the set
is shown as unavailable in the picker and moves to the nearest supported one below it:

```json
"models": {
  "big": { "provider": "anthropic", "model": "claude-opus-5", "supportedEfforts": ["low", "high"] }
}
```

`/thinking off` turns it off — requests then carry no `thinking` parameter at all — and `/thinking on`
turns it back on. Either form writes `thinking` to `<project>/.myagent/settings.local.json` and applies
to the session you are in; the desktop settings screen has the same switch under 通用 › 扩展思考. The
switch is read when a runtime is built, so it also covers subagents.

```json
{ "thinking": false }
```

### The desktop settings screen

The desktop app has a settings screen (`⚙ 设置` at the bottom of the sidebar, or ⌘, on macOS / Ctrl+, elsewhere) covering the
same configuration. Which file each page writes is not uniform, and the screen names the file it is
about to change:

| Page | Writes |
|---|---|
| Models and providers, subagent routing, context management | `~/.myagent/config.json` |
| Permission rules, startup permission mode, extended thinking, prompt-cache TTL, MCP trust | `<project>/.myagent/settings.local.json` |

Two consequences worth knowing:

- Permission rules **concatenate** across settings layers and MCP trust is **unioned**, so the screen can
  only edit the entries in `settings.local.json`. Rules inherited from `~/.myagent/settings.json` or the
  project's `settings.json` are listed as read-only, and a trust granted in one of those files cannot be
  revoked from the screen — remove it there.
- The six context-management numbers are read once when a project starts, so changing them takes effect
  after a restart. Everything else on the screen applies to open sessions immediately.

### Desktop shortcuts on macOS

The desktop title bar reserves space for the native traffic lights, including after resizing,
zooming, and entering or leaving fullscreen. Drag its blank area to move the window.

| Action | macOS | Windows / Linux |
|---|---|---|
| Toggle sidebar | ⌘B | Ctrl+B |
| New session | ⌘T | Ctrl+T |
| Close current session | ⌘W | Ctrl+W |
| Switch open session | ⌘1–9 | Ctrl+1–9 |
| Open project | ⇧⌘O | Ctrl+Shift+O |
| Settings | ⌘, | Ctrl+, |

⌘W closes the active session; the red traffic light closes the window. Native editing,
⌘Q to quit, and Control+⌘F for fullscreen remain available through the macOS menus.

### Image input

A model receives images only when you turn that on for it: `supportsImageInput: true` on the model in
`config.json`, or the 「支持图像输入」 switch in a model form — the desktop settings screen and the TUI
`/provider` dialog both have it, when creating a model and when editing one. It is off by default and
never inferred from the model name or endpoint; two models behind one endpoint can differ. Only the
`anthropic` and `openai` providers carry images in this version — with any other provider the switch
has no effect, and image sends are blocked with the same reason as a text-only model. The switch is a
claim, not a probe: an endpoint that rejects image parts answers with its own error, which Hanekawa
shows together with what to do next.

PNG, JPEG, GIF, and WebP are accepted. The real format is sniffed from the bytes, so a wrong extension
does not matter; EXIF orientation is applied; animated GIF and WebP contribute their first frame; SVG
keeps its text semantics. BMP, HEIC, TIFF, and AVIF are refused with a prompt to convert them to PNG
or JPEG first. The `Read` tool sends image files to the model under the same rules, captioned with the
original and sent dimensions.

Ways to attach, with at most 10 images per input (explicit attachments and `@` images together); a
message can be images alone:

- **Desktop** — paste an image into the composer, drag and drop files, or pick 「选择图片」 from the `+`
  menu. A thumbnail appears per image; clicking it opens a preview, and 「打开原图」 opens the stored
  copy in your viewer.
- **TUI** — `/paste-image` captures the system clipboard, as does `Ctrl+V` where the terminal passes
  that key through. Pasting a standalone image path attaches that file. `@` mentions work for images
  inside the project — files outside the project come in only through an explicit paste, drop, or
  pick. `/attachments` lists the draft; `/attachments remove <n>` and `/attachments clear` manage it.
  On Linux, clipboard capture needs `wl-paste` (Wayland) or `xclip` (X11); when a dependency is
  missing — or under WSL/SSH, where the host clipboard is out of reach — the failure names the reason
  and points at the path and `@` entries.

Every image is stored first and sent as a normalized copy: EXIF-rotated, colors normalized, metadata
stripped, scaled down to a 2,000 px long edge (never enlarged), then compressed — PNG first to keep
text and transparency readable, JPEG for large screenshots — to at most 3.75 MB per image. Raw input
over 20 MB or 40 megapixels is rejected, as is an image that still exceeds the budget at the lowest
quality; the error says which and suggests cropping.

While the active model cannot see images, sending **new** images is blocked before the turn starts —
the draft is kept, and the reason points at `/model`. Images already in the conversation become text
placeholders carrying the file path, with one notice per change rather than one per step. The
originals stay in the session, and switching back to an image-capable model sends them again.
Compaction always summarizes images as text — the compact model needs no image support — and keeps
the latest user message's images; compacted images can be re-read from the cached path. A request
carries at most 100 images, dropping the oldest historical ones first; the current input's images are
never dropped silently.

Attachments live under `<project>/.myagent/attachments/<session-id>/`; the global workspace's sessions
use `~/.myagent/attachments/`. Importing copies the image — your source file is never modified or
deleted, not by sending, by removing a draft attachment, nor by deleting the session. Deleting a
session deletes its stored attachments; closing a pane or restarting keeps them; files nothing
references any more are cleaned up once a 24-hour retention window has passed.

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

### Desktop motion and reading

The desktop uses gentle, visible motion for menus, details, the sidebar and permission
cards. Opening and closing are continuous, and reversing an action continues from its
current position. Streaming text stays readable while new content arrives. Approving or
rejecting a request takes effect immediately and returns focus to the composer while the
card finishes closing.

Thought and tool details that opened during a turn stay open across tool handoffs. When
the whole turn finishes, automatically opened details can fold together. Manual choices,
keyboard focus, text selections and reading further up the conversation are protected.
When you read earlier messages, new output does not pull you back to the bottom.
**Return to latest** moves there immediately.
Restoring a conversation shows its saved content without replaying tool completion effects.

The desktop follows the system's **Reduce motion** preference, including changes made while
it is open. Movement, scaling and looping effects stop, pending visual transitions settle,
and state labels and controls remain available. Navigation and request replies stay immediate.

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
npm test -- test/config.test.ts
npm test -- test/config.test.ts test/cacheBreakDetection.test.ts
```

`npm test` gives its child processes a disposable home and temp directory, then removes
them after success, failure or interruption. Use this entry point for focused tests too.

### Desktop smoke run (the real app)

`npm test` never launches Electron: it is offline and hermetic, and worth keeping that
way. The desktop shell is therefore verified by a separate driver that launches the real
app, drives it over the Chrome DevTools Protocol, and checks what only a running window
can show — that a background session keeps streaming, that a parked permission prompt
survives a session switch, that deleting a session removes every artifact, that the
settings screen persists across a restart.

```bash
npm run build:desktop      # it refuses to run against a stale dist/
npm run smoke:desktop
npm run smoke:desktop -- --first-run
```

It needs a display, so it is a local check. The default run uses your configured
provider. `--first-run` starts with no configuration file and uses a local mock
OpenAI-compatible endpoint: it verifies opening setup, preserving a draft, saving an
endpoint and model through the UI, sending a message, and using the saved model after
a restart. This mode needs no real credentials and makes no external model requests.

- **It does not touch your data.** The app uses scratch projects, a disposable home
  and a private Electron profile. A `0600` copy of `~/.myagent/config.json` supplies the
  providers; test models, project registrations, sessions and file history stay in the
  disposable home. Assertions confirm that the repository's sessions and your real
  config, settings and project registry were left untouched.
- **It spends nothing by default.** One item — a live turn continuing in the background —
  needs a real model turn, and it only runs with `--paid-turn`. That turn is capped by a
  one-shot latch, pinned to the cheapest configured model, and interrupted if it overruns.
- Temporary projects, configuration, browser caches, screenshots and logs are deleted
  after success, failure or interruption. The summary is printed to the terminal.
  Pass `--out=.smoke/<name>` to retain screenshots, logs and a summary, or `--keep` to
  retain the whole scratch environment for debugging. `smoke:motion` follows the same
  cleanup rules. SIGKILL or a power loss cannot run teardown.

Useful flags: `--only=S3,S8` to run named steps, `--verbose` to print passing assertions,
`--kill-stale` with the same `--out` directory to stop its previous smoke process,
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
the TUI. Frontmatter `attachments` remain UTF-8 text files; image and PDF
attachments are not supported there.

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
