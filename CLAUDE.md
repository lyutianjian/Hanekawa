# CLAUDE.md

This file provides guidance for Claude Code when changing Hanekawa.

Hanekawa (package `myagent`) is a self-hosted coding agent with Ink/React TUI and Electron desktop
frontends. It supports persistent sessions, permission-gated tools, subagents, skills, MCP, and context
compaction. User-facing behavior belongs in `README.md`; this file records implementation constraints.

## Commands

Requires Node.js 22+. Run `npm install`; `postinstall` applies the tracked `patch-package` patches.

```bash
npm run dev:tui
npm run start:desktop
npm run typecheck
npm run build
npm run build:desktop
npm run test
npm run smoke:desktop # real Electron/CDP; requires a display and credentials
```

Focused tests:

```bash
node --import tsx --test test/<file>.test.ts
node --import tsx --test --test-name-pattern "pattern" test/<file>.test.ts
```

Tests use `node:test`/`node:assert`, with `fast-check` and selected `ink-testing-library` tests. There is
no lint script.

TypeScript is intentionally split across base, build, preload, renderer, and DOM-test configs.
`tsconfig.build.json` emits `src/**` with `rootDir: "src"`. Preload and renderer configs must retain their
own `exclude`. Tests importing `src/desktop/renderer/dom/` belong in `tsconfig.domtest.json` and in the
base config's `exclude`; `test/rendererImports.test.ts` checks the pairing.

## Architecture

```text
tui/ or desktop/ -> runtime/ + harness/ -> config/providers/
                         |       |
                   sessions/  prompts/  tools/  services/
```

- `harness/`: agent loop, context, permissions, tools, hooks, compaction.
- `runtime/`: project/session lifetimes, queues, commands, and protocol.
- `sessions/`: append-only JSONL records and the `RecordStream` persistence port.
- `prompts/`: prompt composition and budgets; a leaf that must not import `harness/`.
- `config/`: settings, models, routing, retries, and provider construction.
- `tools/`: hand-maintained built-ins; register them in `src/tools/index.ts`.
- `services/`: project context, checkpoints, background tasks, skills, and memory.
- `tui/`: Ink shell. `desktop/`: Electron main, preload, shell host, and renderer.

`services/` may depend on `tools/`, not the reverse. The harness uses `RecordStream`, never
`SessionStore` directly. Keep decisions in their owning runtime/model layer instead of Electron entry
points or views.

## Runtime and sessions

- One `ProjectRuntime` is shared per `cwd`; `ProjectDirectory` must not create duplicates. Settings and
  agent definitions are read live, while MCP containers/tool arrays are mutated in place so existing
  holders and subagent closures see reloads.
- `agent.contextManagement` and `permissions.mode` are snapshotted when a session scope is built. Reloads
  do not change open sessions; user-facing edits must say so.
- Every conversation owns its `SessionScope`/`SessionPane`, bridge, permission gate, prompt cache, loop,
  tool runner, context builder, and record stream. Never share these across sessions or subagent runs.
- `SessionWorkspace` owns one pane per session plus switch, `/clear`, and `/resume` choreography.
  `SessionHost` is the protocol endpoint; desktop `ShellHost` owns cross-project pane topology.
- Preserve lifecycle order: install a replacement runtime before disposing the old one; interrupt a pane
  before releasing its scope; close the workspace before the project; await projects already closing in
  `shutdownAll`. Shutdown timeouts stop waiting but do not cancel work.
- Desktop lane keys are stable and distinct from mutable session IDs. Closing a pane releases a runtime;
  it does not delete the session or stop project background tasks.

## Loop, tools, and context

- `AgentLoop.run()` and `runTool()` must use the shared enqueue path and single in-flight guard.
- Tool aborts can resolve as `tool_result` with `errorCode === "aborted"`. Preserve abort/error semantics.
- `ToolRunner` must settle approval, result, and post-use records for validation failures, denial, abort,
  and hook blocks. Batching belongs to the loop and only groups contiguous safe calls.
- Before provider calls, repair unmatched `tool_use`/`tool_result` pairs. A model switch invalidates
  model-dependent prompt/cache state; compaction that changes context requires a fresh token count.
- Compaction must retain the latest user message. Automatic failures are fail-open behind the per-session
  circuit breaker. Cache sources and module state must not cross sessions, streams, or projects.
- Provider-supported micro-compaction uses cache editing; never mutate local session records as a stand-in.

## Permissions and configuration

- Permission modes are `default`, `plan`, `acceptEdits`, `bypass`, and `readonly`. `bypass` still obeys
  deny/ask rules, Windows path safety, and protected paths (`.git`, `.vscode`, `.idea`, `.myagent`).
- Preserve the existing asymmetric shell rule matcher: deny/ask operates on command segments; allow does
  not use the same matching semantics.
- Apply mode changes through `applyPermissionModeTransition`. Turn abort does not settle prompts, so pane
  close and UI teardown must resolve permission, AskUserQuestion, and plan requests via their fallbacks.
- Configuration is global plus project-local, with project values winning. Use the existing
  `ConfigService` persistence/reload flow.
- Values read through `ConfigService` (`models`, `endpoints`, `routing`, `agent.*`) belong in config, not a
  settings file that `config.json` can override. In-app settings writes use `updateLocalSettings` and must
  not call `save()` on the merged config.
- `permissions.*` and `hooks.*` concatenate across settings layers; `mcp.trustedServers` is unioned.
  Write a group whole and do not claim inherited entries can be removed from the local layer.
- Routing targets a model key or `inherit`; missing targets degrade to `inherit`. Register providers in
  `src/config/providers/registry.ts` and preserve native/proxy capability checks.
- `FallbackTriggeredError` is a retry signal and must reach the loop's fallback activation path.

## TUI and protocol

- `src/tui/entrypoints/tui.tsx` is the TUI wiring entry point. `SessionController` owns turn lifecycle;
  subscribe with `onEvent` and do not add duplicate record handlers.
- Session switches, `/clear`, and `/resume` use the shared switch choreography, including queue rebinding
  and runtime replacement. Queue pumping must re-check blocking UI requests.
- Use the shared theme and clock; no literal component colors or `setInterval` animation. Keep row
  estimators synchronized with rendered layout.
- `src/runtime/protocol/` is Electron-free. Wire values must survive `structuredClone`; send DTOs/model
  keys, never providers, tools, functions, or host objects.
- Validate inbound commands with strict schemas. Keep dispatch exhaustive with `assertNever`; do not add
  catch-all defaults.
- Renderer code must not value-import Node-only layers (`harness/`, `services/`, `sessions/`, `commands/`,
  `tui/`). Put pure decisions in `renderer/model/`, DOM/event wiring in `renderer/dom/` or the app shell,
  and settle every blocking request.

## Desktop shell

- One `BrowserWindow` multiplexes pane lanes over one transport. The shell, not a project host, owns
  cross-project topology.
- All lane exits use the common detach/dispose path. The last lane permits project shutdown.
  `settleAfterLastLane` is deferred only by session deletion; a deferring caller must run it if draft
  replacement fails. Do not branch it on the free-form `reason` string.
- Settings changes follow `mutate -> save if config changed -> reload -> after-reload action -> optional
  refresh/rebuild`. Each `SettingsChange` declares this once and has a globally unique `kind`.
- Window-level views derive session identity from `WireLaneInfo`. Usage/cost/streaming belongs below the
  composer; model/effort belongs on its chip, permission mode on its pill, and session name in the header.
- The frameless title bar is draggable; every control in it is `no-drag`, and the Windows control strip
  stays empty. `WINDOW_CHROME` is the only color allowed outside `styles.css`; theme changes repaint it.
- `body` alone paints the window wash; `#titlebar` and `#sidebar` stay transparent, while `#canvas` is
  opaque. Do not introduce `backdrop-filter` or `backgroundMaterial`.
- `open-in-editor` is awaited and carries `projectRoot`; resolve it to the real `entry.cwd`. Keep process
  spawning in `src/desktop/openInEditor.ts`.
- Delete sessions through `src/runtime/deleteSession.ts` after resolving the real session ID and detaching
  any open lane. Removing JSONL alone leaves related artifacts.
- `scripts/smoke-desktop.mjs` covers real `main.ts` behavior. It must use scratch projects and restore the
  developer's renderer theme preference. Native modals and OS-painted title controls are not screenshotable.

## Renderer invariants

- Project data lives under `<cwd>/.myagent/`; global settings/config under `~/.myagent/`. Sessions are
  append-only JSONL; drafts may remain in memory. Checkpoints use per-session shadow Git and must not
  modify the working tree.
- Changes to `hasOverlay` or `isStreaming` must call `onShellChanged`, because sidebar badges derive from
  `shellState()`.
- Session row CSS order is load-bearing: `.selected`, then `.active`, then `.confirming`. Keyboard cursor,
  open lane, visible lane, and delete confirmation are separate states.
- Every class passed to `controls.ts`'s `button()` needs a resting-state CSS rule. Update the explicit
  control lists in `rendererStyleTokens.test.ts` where its scan cannot infer coverage.
- Dropdown/popover ancestor chains (`.settings-column`, `.composer-column`, menu shells) must not clip via
  `overflow`. Composer popovers remain absolute above the composer with the established pointer-event and
  z-index layering.
- `--accent-*` does not fill backgrounds except `.settings-toggle.on`; keep
  `ACCENT_FILL_EXCEPTIONS` exact.
- Model and effort are one `#chip-runtime` control. Its rows reuse picker decisions and persist changes via
  `run-command`; keep rows stable while switching flyouts and cancel stale opens in `closeMenus()`.
- Short transcripts bottom-align through `.transcript-column { margin-top: auto; flex-shrink: 0; }`; it
  remains the scroller's only child. Do not replace this with `justify-content: flex-end`.
- Dropdown glyphs use `trailingIcon`; `.btn-label` must flex so long labels do not eject the glyph.
- The canvas hairline is an inset `outline`, not a border or box shadow. `#overlay`/`#rewind` stay absolute
  inside the positioned, overflow-hidden canvas and above popovers without giving `#canvas` a z-index.
- Blocking dialogs derive rows/buttons and intents in `model/`. Mouse and keyboard actions share the same
  intent mapping; the backdrop never dismisses a request. Suggestions accept on prevented `mousedown`.
- Screens with key handlers take focus once when opened, not on every render.
- In `app.ts`, construct `mux`/`shellClient` before the top-level theme block; `rendererBoot.test.ts` guards
  this runtime-only ordering constraint.
- Prefer pure model tests. DOM tests use `test/helpers/domStub.ts`; keep its source-scan guards synchronized
  with supported `document` members.

## Tests and workflow

Read the owning module, nearest tests, and relevant types before editing. Reuse existing helpers,
registries, DTOs, and model functions. Preserve unrelated worktree changes and add focused regression
coverage for changed contracts.

Run the narrowest relevant tests first. For shared or cross-layer contracts, run `npm run typecheck` and
the full suite. Useful groups:

- Runtime/session: `sessionWorkspace`, `sessionSwitch`, `projectDirectory`, `multiProject`, `deleteSession`.
- Loop/context/cache: `compact`, `cacheBreakDetection`, `contextBuilder`, cache-aware integrations.
- Tools/config/permissions: `tools`, `config`, `permissions`, `settingsPersistence`.
- Protocol/desktop: `protocolWire`, `protocolHost`, `protocolCommandSchema`, `protocolClientParity`,
  `desktopShellHost`, `desktopMain`.
- TUI/renderer: `tuiLayout`, `tuiTheme`, `rendererImports`, renderer model/view tests,
  `desktopUiRoundTrip`, and `rendererBoot`.
- Build/patches: `distBuild`, `desktopBuild`, `tuiInkPatch`.

Reset module caches in tests that change environment, project, or session scope.

## Conventions

- Use `.js` extensions for relative imports.
- Import strict schemas from `zod/v3`.
- Prefer pure functions and direct tests; comment only non-obvious constraints or ordering.
- Keep `ink+7.0.6.patch` and `wrap-ansi+10.0.0.patch` paired; `tuiInkPatch.test.ts` covers them.
- Treat implementation and tests as source of truth; update this guide when an invariant changes.
- Keep `AGENTS.md` and `CLAUDE.md` synchronized except for title and first guidance sentence.
- `todo.md` tracks desktop-port work.
