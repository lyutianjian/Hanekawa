# CLAUDE.md

This file provides implementation guidance for Claude Code when changing Hanekawa.

Hanekawa (package `myagent`) is a self-hosted coding agent with Ink/React TUI and Electron desktop frontends. It supports persistent sessions, permission-gated tools, subagents, skills, MCP, and context compaction. User-facing behavior belongs in `README.md`.

## Commands

Requires Node.js 22+. Run `npm install`; `postinstall` applies the tracked `patch-package` patches.

```bash
npm run dev:tui
npm run start:desktop
npm run typecheck
npm run build
npm run build:desktop
npm run test
npm run smoke:desktop
```

Focused tests:

```bash
node --import tsx --test test/<file>.test.ts
node --import tsx --test --test-name-pattern "pattern" test/<file>.test.ts
```

Tests use `node:test`/`node:assert`; there is no lint script. TypeScript configs are intentionally split across base, build, preload, renderer, and DOM tests—keep their `rootDir`/`exclude` boundaries intact.

## Architecture

```text
tui/ or desktop/ -> runtime/ + harness/ -> config/providers/
                         |       |
                   sessions/  prompts/  tools/  services/
```

- `harness/`: agent loop, context, permissions, tools, hooks, compaction.
- `runtime/`: project/session lifetimes, queues, commands, protocol.
- `sessions/`: append-only JSONL records through `RecordStream`.
- `prompts/`: prompt composition and budgets; never imports `harness/`.
- `config/`: settings, models, routing, retries, providers.
- `tools/`: one directory per built-in (`GrepTool/`, `FileEditTool/`, ...) plus shared helpers at the root, all registered in `src/tools/index.ts`.
- `services/`: project context, file history, background tasks, skills, memory.
- `tui/`: Ink shell; `desktop/`: Electron main, preload, shell host, renderer.

`services/` may depend on `tools/`, not the reverse. The harness uses `RecordStream`, never `SessionStore` directly. Keep decisions in the owning runtime/model layer, not Electron entry points or views.

## Runtime and sessions

- Share one `ProjectRuntime` per `cwd`; `ProjectDirectory` must not duplicate it. Settings and agent definitions are read live; MCP containers/tool arrays are mutated in place.
- Each conversation owns its scope, pane, bridge, permission gate, prompt cache, loop, tool runner, context builder, and record stream. Never share these across sessions or subagent runs.
- `agent.contextManagement` and `permissions.mode` are snapshotted when a session scope is built; reloads do not change open sessions.
- Lifecycle order: install a replacement runtime before disposing the old one; interrupt a pane before releasing its scope; close the workspace before the project; await already-closing projects in `shutdownAll`.
- `main.ts ensureProject` is the only bootstrap path. It registers roots in `~/.myagent/projects.json` in added order; startup always opens a new empty session and uses a registered or explicit root, never bare `process.cwd()`.
- The home directory is the global workspace (最近); use `projectIsGlobal`, never display-name matching. The sidebar reads the registry and global session index live; only `remove-project` removes an added project row.
- Resolve root-keyed commands through `ShellHost.cwdForRoot` or `ensureEntryForRoot`, never `knownCwdForRoot` alone.
- Closing a lane releases a runtime but does not delete the session or stop project background tasks. Use the dedicated session/project deletion paths so all artifacts are removed.

## Loop, tools, and context

- `AgentLoop.run()` and `runTool()` use the shared enqueue path and one in-flight guard. Preserve abort/error and `tool_result` semantics.
- `ToolRunner` settles approval, result, and post-use records for every failure, denial, abort, or hook block. Only the loop batches contiguous safe calls.
- Repair unmatched `tool_use`/`tool_result` pairs before provider calls. A model switch invalidates model-dependent prompt/cache state; changed compaction context needs a fresh token count.
- Compaction retains the latest user message. Automatic failures are fail-open behind the per-session circuit breaker. Cache sources and module state never cross sessions, streams, or projects.
- File tools read through `src/tools/textFile.ts` and write through `writeTextFile`: normalize reads to LF, preserve encoding/line endings on write, and keep `Read`’s whole-file state available to `Edit`.
- Every built-in tool is a `src/tools/<Name>Tool/` directory: the implementation, and a `prompt.ts` holding its description plus any tool-name constants. Descriptions name every accepted parameter and every capability the model's Claude Code prior expects but this tool lacks.
- `src/tools/inputAliases.ts` normalizes input before permissions, hooks, display, records, or execution read it. Renaming an alias onto a real parameter beats dropping it; dropping is for keys no parameter could honour. The prompt’s shell line comes from `describeShell()` in `src/tools/BashTool/BashTool.ts`.
- Project instructions are `AGENTS.md`/`CLAUDE.md` and `.myagent/rules/*.md` walked upward from `cwd`, first match per directory, outermost first; local `AGENTS.local.md`/`CLAUDE.local.md` is read last.

## Permissions and configuration

- Modes are `default`, `plan`, `acceptEdits`, `bypass`, and `readonly`. Only an explicit deny rule or readonly mode denies without asking; `bypass` still honors deny/ask rules and path safety.
- Protected paths gate writes only. Extract file paths separately from shell commands; Windows path safety runs in every mode; dangerous removals are never auto-approved.
- Preserve shell-rule semantics, read-only command validators, accept-edits operand checks, `WebFetch` host scoping, and tool-family rule aliases (`Edit` → write tools, `Read` → `Grep`/`Glob`).
- `config.json` is global only. Models, endpoints, routing, and `agent.*` belong in `ConfigService`; migrate any project leftovers before the first load.
- Settings groups concatenate/union across layers, except `skills.disabled`, which is replaced per layer. Provider construction stays in `src/config/providers/registry.ts`.
- Preserve provider capability checks, retry/fallback propagation, and reference repair when models/endpoints are deleted. `ModelConfig.longContext1m` and `contextWindow` are independent.

## TUI, protocol, and desktop

- `src/tui/entrypoints/tui.tsx` is the TUI wiring point; `SessionController` owns turn lifecycle. Session switches, `/clear`, and `/resume` use the shared choreography and re-check blocking UI requests.
- Use the shared theme and clock. `src/runtime/protocol/` is Electron-free; wire values survive `structuredClone`, commands use strict schemas, and dispatch is exhaustive with `assertNever`.
- Renderer code must not value-import `harness/`, `services/`, `sessions/`, `commands/`, or `tui/`. Put pure decisions in `renderer/model/`, DOM/event wiring in `renderer/dom/` or the app shell, and settle every blocking request.
- One `BrowserWindow` multiplexes pane lanes over one transport; desktop `ShellHost` owns cross-project topology and all lane exits use the common detach/dispose path.
- Settings changes follow `mutate -> save if config changed -> reload -> after-reload action -> optional refresh/rebuild`, with unique change kinds, optimistic pending state, and one wire scope per category (except renderer-local `appearance`).
- Window views derive identity from `WireLaneInfo`. Context occupancy uses `AgentLoop.getContextBudget().usableContextWindow`, not the raw model window. `open-in-editor` resolves the real `entry.cwd`.
- Context occupancy is `usage.lastRequest` (input + cache read), pushed per provider response through `RecordProxy.onRequestUsage` and seeded from the metrics sidecar (`SessionStore.loadLastRequestUsage`) for a session this process never ran. A mid-turn report moves `lastRequest` only — the totals stay on the end-of-run accounting, or every request is counted twice. The record-only estimate in `currentContextUsed` counts neither the system prompt nor the tool schemas; it is the last resort, not a source.
- `scripts/smoke-desktop.mjs` exercises real Electron behavior with scratch projects, and restores renderer preferences, `~/.myagent/config.json` and `~/.myagent/projects.json` in a teardown that never throws.

## Renderer invariants

- Project data lives under `<cwd>/.myagent/`; global settings/config under `~/.myagent/`. Sessions are append-only JSONL.
- `/rewind` restores from per-session file history in `~/.myagent/file-history/`, never from the worktree: write tools call `trackFileEdit` *before* writing, `makeSnapshot` opens a snapshot per turn, and restores are addressed by `messageId`. Only files the agent's tools touched are captured. Keep backups deduplicated by version, collect a backup only once no surviving snapshot names it, and keep every per-file failure local — there is no session-wide disable.
- Changes to `hasOverlay` or `isStreaming` call `onShellChanged`. Streaming turns post `session-event` and `snapshot`; keep frame/render-signature work bounded.
- Every popover closes three ways: a press outside it (`dom/dismiss.ts`'s `onPressOutside`, scoped to the popover **and its trigger**, never to the bar around them), `focusout`, and Escape. A `focusout` with `relatedTarget === null` is the view's own repaint and must be ignored, and a `focus()` inside a paint goes last — it fires `focusout` synchronously, and a handler that repaints in answer re-enters the paint.
- Reuse the existing renderer model/view helpers, styling tokens, overlay behavior, and focus rules. Prefer pure model tests; DOM tests use `test/helpers/domStub.ts`.
- Markdown math is split in two: `renderer/model/markdown.ts` only *finds* TeX (a `marked` extension on a private `Marked` instance, four delimiter pairs) and `dom/markdownView.ts` typesets it with `katex.render` — the DOM-tree form, never `renderToString`, which `dom/dom.ts`'s innerHTML ban rules out. `katex.css` and its woff2 are copied out of `node_modules` by `scripts/copy-desktop-assets.mjs`, woff/ttf sources stripped.

## Workflow and conventions

Read the owning module, nearest tests, and relevant types before editing. Reuse existing helpers, registries, DTOs, and model functions. Preserve unrelated worktree changes and add focused regression coverage.

Run the narrowest relevant tests first; run `npm run typecheck` and the full suite for shared/cross-layer changes. Reset module caches when tests change environment, project, or session scope.

- Use `.js` extensions for relative imports.
- Import strict schemas from `zod/v3`.
- Keep `ink+7.0.6.patch` and `wrap-ansi+10.0.0.patch` paired.
- Keep `AGENTS.md` and `CLAUDE.md` synchronized except for the title and first guidance sentence.
- `todo.md` tracks desktop-port work.

## Instructions 

For simple or low-risk tasks, reduce writing unnecessary tests and avoid overly defensive programming.
