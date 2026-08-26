# AGENTS.md

This file provides guidance for Codex and other coding agents when changing Hanekawa.

Hanekawa (package `myagent`) is a self-hosted coding agent with an Ink/React terminal UI and an
Electron desktop UI. The provider-agnostic agent loop supports persistent sessions, permission-gated
tools, subagents, skills, MCP, and context compaction. User-facing behavior is documented in `README.md`.

## Commands

Requirements: Node.js 22 or newer. Install dependencies with `npm install`; `postinstall` applies the
tracked `patch-package` patches.

```bash
npm run dev:tui       # terminal UI
npm run start:desktop # Electron desktop UI
npm run typecheck     # base, preload, renderer, and DOM-test TypeScript programs
npm run build         # compile Node/Electron main sources
npm run build:desktop
npm run test
npm run smoke:desktop # real Electron over CDP; needs a display, not part of `npm test`
```

Focused tests use:

```bash
node --import tsx --test test/<file>.test.ts
node --import tsx --test --test-name-pattern "pattern" test/<file>.test.ts
```

Tests use `node:test` and `node:assert`; property tests use `fast-check`, and selected TUI tests use
`ink-testing-library`. There is no lint script.

The TypeScript programs are coupled but intentional: the base config covers Node/TUI/tests,
`tsconfig.build.json` emits `src/**` to `dist/**` and requires `rootDir: "src"`, while
`tsconfig.preload.json` and `tsconfig.renderer.json` add DOM libraries. The preload and renderer
configs must keep their own `exclude`, or they can become empty programs and report a false green.

`tsconfig.domtest.json` is the fourth program: tests that import `src/desktop/renderer/dom/`. The base
`lib` is `ES2022` only, and that absence is the only thing stopping host and TUI code from touching
`document` — so such a test is listed in the base `exclude` and checked here instead. Both lists have to
move together; `test/rendererImports.test.ts` asserts they do.

## Architecture

```text
tui/ or desktop/ -> runtime/ + harness/ -> config/providers/
                         |       |
                   sessions/  prompts/  tools/  services/
```

- `harness/`: agent loop, context assembly, permissions, tool execution, hooks, and compaction.
- `runtime/`: project/session lifetimes, runtime replacement, queues, slash commands, and protocol.
- `sessions/`: append-only JSONL records and the `RecordStream`/store boundary.
- `prompts/`: prompt composition and token budgeting; it is a leaf and must not import `harness/`.
- `config/`: settings, models, routing, retries, and provider construction.
- `tools/`: hand-maintained built-in tools. Register new built-ins in `src/tools/index.ts`.
- `services/`: project context, checkpoints, background tasks, skills, and session memory.
- `tui/`: Ink terminal shell. `desktop/`: Electron main process, preload, shell host, and renderer.

`services/` may depend on `tools/`, but dependency direction should not be reversed. The harness talks
to a `RecordStream`, not directly to `SessionStore`, so persistence remains behind the session port.

### Runtime ownership

- `ProjectRuntime` is shared by sessions in one `cwd`: config, store, tools, commands, MCP clients, and
  background tasks. `getSettings()` is the live merged settings, `listAgentDefinitions()` the merged agent
  definitions, and `mcp` is mutated in place by `reloadMcpServers()` so holders never read a stale
  snapshot. `reloadMcpServers()` never prompts for trust — the trust setting is what grants it.
- `agent.contextManagement` and `permissions.mode` are snapshotted when a scope is built, so neither
  `reloadSettings()` nor a runtime rebuild reaches an open session; anything that edits them must say so.
- `SessionScope`/`SessionPane` is per conversation. Do not share bridges, permission gates, prompt
  section caches, or agent loops between sessions.
- `ProjectDirectory` owns multiple projects and must not create duplicate runtimes for one project.
  A `closeProject` in flight is held on the directory, so `shutdownAll` awaits the ones already leaving
  (they are out of `entries()` before the first await) as well as the ones still registered. Its
  `timeoutMs` is the quit's watchdog — `SHUTDOWN_DEADLINE_MS`, passed by `main.ts`'s `teardown()` — and
  hitting it only stops waiting; nothing is cancelled.
- `SessionWorkspace` enforces one pane per session and owns session switching/clearing choreography.
- `SessionHost` is the host-side protocol endpoint. Desktop `ShellHost` multiplexes panes as lanes and
  owns cross-project pane topology.

Preserve lifecycle order: install a replacement runtime before disposing the old one; close a pane by
interrupting first and releasing its scope last; close the workspace before shutting down a project;
and keep stable desktop lane keys separate from session IDs, which can change on `/clear` and `/resume`.
Closing a pane releases a runtime but does not delete its session or stop project-level background tasks.

## Agent loop, context, and compaction

Relevant entry points include `src/harness/loop.ts`, `contextBuilder.ts`, `compact.ts`, and
`src/prompts/budget.ts`.

- `AgentLoop.run()` and `runTool()` use the shared enqueue path; do not bypass the single in-flight
  guard for records, tool context, or the record stream.
- Tool aborts may resolve as `tool_result` with `errorCode === "aborted"`; callers that await a tool
  must preserve the loop's abort/error semantics.
- A model switch invalidates model-dependent prompt sections and cache state. Compaction also requires
  a fresh token recount when it changes the selected context.
- Context selection must repair unmatched `tool_use`/`tool_result` pairs before sending provider data.
- Compaction must not remove the most recent user message. Automatic compaction failures are fail-open
  and protected by a session-level circuit breaker.
- Cache sources and related module state are scoped to the session/project; never reuse a source across
  projects or independent streams.
- Ratio-based micro-compaction follows the provider cache-edit path when supported; it must not mutate
  local session records as a substitute.

## Tools, permissions, and providers

### Tools and subagents

- `src/tools/index.ts` is hand-maintained; display/deferred-tool registrations must stay consistent.
- Batching is performed by the loop, not `ToolRunner`, and only groups contiguous safe calls.
- `ToolRunner` emits the expected approval/result/post-use records on validation failure, denial, abort,
  and hook-block paths; do not return early without settling the record lifecycle.
- Each subagent run owns its permission gate, tool runner, context builder, loop, and record stream.

### Permissions

- Permission modes include `default`, `plan`, `acceptEdits`, `bypass`, and `readonly`.
- `bypass` still respects deny/ask rules, Windows path safety, and protected paths such as `.git`,
  `.vscode`, `.idea`, and `.myagent`.
- Bash deny/ask matching covers command segments; allow matching is intentionally different. Preserve
  the existing shell-rule matcher instead of replacing it with one symmetric matcher.
- Permission prompts are not automatically released by a turn abort. UI teardown and pane close paths
  must settle pending permission/AskUserQuestion/plan requests with their defined fallbacks.
- Mode changes go through `applyPermissionModeTransition` so the gate and plan manager stay consistent.

### Providers and configuration

- Routing selects a model key or `inherit`; it is not a tier system. A missing routing target degrades
  to `inherit` rather than making configuration unusable.
- Configuration is layered globally and per project, with project values taking precedence. Settings
  and config mutations must use the existing `ConfigService` persistence and reload flow.
- `config.json` layers on top of the settings files, so anything read through `ConfigService`
  (`models`, `endpoints`, `routing`, `agent.*`) must be written with `ConfigService`, not into a settings
  layer where a config file would silently override it.
- In-app settings writes go through `updateLocalSettings` in `src/config/settings.ts`, which rewrites only
  the named keys of `<cwd>/.myagent/settings.local.json` and validates before writing. `permissions.*` and
  `hooks.*` concatenate across layers and `mcp.trustedServers` is unioned, so a group must be written whole
  and inherited entries can be neither removed nor revoked from the local layer.
- Register providers through `src/config/providers/registry.ts` (`PROVIDER_FACTORIES`).
- Native Anthropic endpoints and Anthropic-compatible proxies have different cache, tool-schema, beta,
  and context-management capabilities; preserve the existing capability checks.
- Provider overload fallback is a retry-layer signal (`FallbackTriggeredError`) and must reach the loop's
  fallback activation path instead of being swallowed as an ordinary provider failure.

## TUI, protocol, and desktop

### TUI

- `src/tui/entrypoints/tui.tsx` is the TUI wiring entry point. `SessionController` owns turn lifecycle;
  subscribe with `onEvent` and do not install duplicate record handlers.
- Session switches, `/clear`, and `/resume` must use the shared session-switch choreography, including
  queue rebinding and runtime replacement.
- MessageQueue is persisted as session records. Queue pumping must re-check whether blocking UI requests
  are pending; an open panel alone is not necessarily blocking.
- Runtime tool arrays are mutated in place so MCP reconnects update existing subagent closures.
- Use the shared theme and clock. Do not add literal component colors or `setInterval` animation.
- Keep layout row estimators synchronized with their render components.

### Process boundary

`src/runtime/protocol/` is Electron-free. Wire messages must survive `structuredClone`; send model keys
and DTOs, never live providers, tools, functions, or other host objects. Validate inbound commands with
the existing strict schemas. Keep command execution exhaustive with `assertNever`; do not add a catch-all
default that silently ignores a new command variant.

Renderer code must not value-import Node-only layers such as `harness/`, `services/`, `sessions/`,
`commands/`, or `tui/`. Keep renderer decisions in DOM-free `model/` modules and leave DOM/event wiring
to `dom/` and the app shell. Every blocking UI request must be answered or settled by its fallback.

### Desktop shell and lanes

- One BrowserWindow carries multiple pane lanes over one transport. A lane key is stable; a session ID
  is not.
- All lane exits use the common detach/dispose path. The last lane closing a project is what permits
  project shutdown; application teardown must preserve this ordering. `detachLane`'s tail —
  `closeProject` plus `onAllLanesClosed`, which quits the app off darwin — is `settleAfterLastLane`,
  and only `deleteSession` defers it (`{ deferExit }`), because deleting the window's last session
  opens a draft in its place instead of quitting. A caller that defers owns running it if the
  replacement fails. Do not branch that tail on `reason`: it is a free string for logs and `shutdown()`.
- The shell, not an individual host, is the authority for pane topology across projects. A host creates
  or manages panes only within its own project and delegates cross-project actions to the shell.
- Settings changes follow `mutate -> save (only if the config changed) -> reload -> after-reload action ->
  refresh/rebuild (only if the variant needs it)`; do not reload before saving, do not save for a
  settings-layer edit (`save()` writes the whole merged config), and do not fan a rebuild out for an edit
  that is already read live. Each `SettingsChange` variant declares this in one place.
- `SettingsChange` is keyed by `kind` alone in the host's schema table and dispatch, so a new variant needs
  a globally unique `kind`; the keyed `satisfies` and `assertNever` are what fail the build by name.
- The canvas header, the title bar, the sidebar and the settings screen are *window*-level views:
  everything the header draws comes off `WireLaneInfo`, so session identity has one source and no pane is
  involved. The status line carries usage, cost and streaming only, sits under the composer (never across
  the top of the canvas) and is empty while idle — the model and effort live on the composer's chip, the
  permission mode on its pill, and the session name in the header. `document.title` stays in
  `statusView.renderSession`, where it still means "a `hello()` came back".
- The window is frameless (`titleBarStyle: 'hidden'`), so `#titlebar` is a drag region and every control
  in it must be `no-drag`; the strip on its right is where Windows paints its own three buttons and must
  stay empty. `main.ts` sets `backgroundColor` (no white flash) and clears the application menu off
  darwin. `WINDOW_CHROME` in `main.ts` is the one place outside `styles.css` allowed to spell a colour —
  the overlay is OS-painted chrome no stylesheet reaches — and `set-window-theme` is what repaints it;
  unlike `open-project`/`open-in-editor`, a shell with no overlay answers `ok` rather than rejecting.
  Every title-bar menu item must map to an intent that already exists, and there is no 编辑 menu.
- `open-in-editor` is awaited by the shell (unlike `open-project`, which is fire-and-forget), so a missing
  `code` reaches the renderer as a `fail` rather than a native box. It carries `projectRoot` — the only
  project handle the renderer has — and the host resolves it to `entry.cwd`, never handing the normalized
  key to a process. The spawn itself lives in `src/desktop/openInEditor.ts` so it can be unit-tested.
- Deleting a session requires resolving the real session ID first, detaching an open lane if necessary,
  and removing all associated artifacts through the runtime deletion path.
- `main.ts` still has no unit test, so `scripts/smoke-desktop.mjs` is what covers it: it launches the real
  app against scratch projects (`--cwd=`), drives it over CDP, and asserts the ten stage-4 acceptance items.
  It stays out of `npm test` (it needs a display, an endpoint and credentials) and it must stay pointed at a
  temp directory — its own tripwires assert the repo's `.myagent/` and both global files were untouched.
  Anything reachable only through a native modal cannot be smoke-tested: those block the main process, and a
  screenshot cannot see them. Keep `open-project` answerable with a `path`.

## Regression tests by area

Use the smallest relevant test set while developing, then run `npm run typecheck` and the full suite for
cross-layer changes.

- Runtime/project/session: `sessionWorkspace.test.ts`, `sessionSwitch.test.ts`, `projectDirectory.test.ts`,
  `multiProject.test.ts`, and `deleteSession.test.ts`.
- Loop/context/cache: `compact.test.ts`, `cacheBreakDetection.test.ts`, `contextBuilder.test.ts`, and
  the cache-aware compact integration tests.
- Tools/config/permissions: `tools.test.ts`, `config.test.ts`, `permissions.test.ts`,
  `settingsPersistence.test.ts` for anything written to a settings or config layer, and the relevant
  command or tool tests.
- Protocol/desktop: `protocolWire.test.ts`, `protocolHost.test.ts`, `protocolCommandSchema.test.ts`,
  `protocolClientParity.test.ts`, `desktopShellHost.test.ts`, and `desktopMain.test.ts`.
- TUI/renderer: `tuiLayout.test.ts`, `tuiTheme.test.ts`, `rendererImports.test.ts`, the corresponding
  renderer model test, and `desktopUiRoundTrip.test.ts` for an end-to-end UI path.
- Build/patches: `distBuild.test.ts`, `desktopBuild.test.ts`, and `tuiInkPatch.test.ts`.

When a test changes environment variables or project/session scope, reset the associated module cache;
otherwise a passing test can contaminate later cases.

## Change workflow

- Read the local module, its nearest tests, and the relevant type definitions before changing behavior.
- Prefer existing helpers, registries, protocol DTOs, and presentation/model functions over new parallel
  abstractions.
- Keep changes within the owning layer. Move cross-layer decisions into runtime/model modules rather than
  putting them in the Electron entry point or a view component.
- Preserve unrelated working-tree changes. Do not reset or overwrite files you did not need to change.
- Add focused regression coverage for changed contracts, especially lifecycle order, wire shapes, cache
  isolation, permissions, and renderer import boundaries.
- Run the narrowest relevant tests first; use typecheck and the full suite when shared contracts change.
- Treat tests and implementation as the source of truth if this guide becomes stale; update this guide
  in the same change when a documented invariant intentionally changes.
- Put user-facing setup and behavior in `README.md`; keep this file focused on constraints needed to
  change the implementation safely.

## Renderer and persistent state

- Renderer `model/` modules contain pure decisions; DOM modules construct nodes and attach events.
- Do not use Node globals or filesystem access outside the existing host-mediated paths. Markdown is
  parsed safely and must not be rendered with `innerHTML`.
- Project data lives under `<cwd>/.myagent/`; global settings/config live under `~/.myagent/`.
- Sessions are append-only JSONL. New sessions may remain in-memory drafts until their first message.
- Checkpoints use a per-session shadow Git repository and must not modify the user's working tree.
- Use `src/runtime/deleteSession.ts` to delete a session; removing only its JSONL leaves shadow, memory,
  or subagent artifacts behind.
- The sidebar repaints only when something calls `onShellChanged`, and its badges are derived from
  `shellState()`. Anything that moves `hasOverlay` or `isStreaming` must announce it: a `hasOverlay`
  transition that stays silent leaves a badge that is corrected only by the next unrelated snapshot tick.
- A screen with its own `keydown` handler must take focus when it opens, or its documented keys are dead.
  The settings screen is `tabindex="-1"` and focuses itself on the open transition only — focusing on every
  render would pull the caret out of a form field.
- Every class passed to `controls.ts`'s `button()` needs a **resting-state** rule in `styles.css`; an
  unstyled button falls back to the user agent's filled control, which no typecheck can see.
  `rendererStyleTokens.test.ts` enforces it, and `:hover`/`:disabled` rules alone do not count. That scan
  is coarse in two known ways: it skips `controls.ts` itself, and it accepts a class that only ever appears
  as an ancestor's descendant or under a state class. Controls built inside `controls.ts`, the
  transcript's own, and the 5e header/composer chrome are therefore covered by three explicit class lists
  in the same test — extend the right list when adding a control.
- A row-level dropdown (`pillSelect`) is absolutely positioned against its own `.settings-menu-shell` and
  opens downward without measuring anything, so **no ancestor of it inside the settings screen may clip**:
  `.settings-card` carries its bottom corners on `> :last-child` rather than `overflow: hidden`, and
  `.settings-body` scrolls (`auto`), which extends instead of cutting. `rendererSettingsView.test.ts`
  asserts the chain at selector level (`helpers/rendererCss.ts` parses the sheet for both it and
  `rendererStyleTokens.test.ts`); only smoke step 8's `elementFromPoint` probe can prove the pixels,
  because a clipped node still reports its full rect.
- `--accent-*` may colour a glyph, a hairline or a state rule, never a `background`. The single exception is
  `.settings-toggle.on`, named in `ACCENT_FILL_EXCEPTIONS` in `rendererStyleTokens.test.ts` (a switch has no
  label, so the coloured track *is* the state); the list is checked for non-vacuity, so do not widen it and
  do not leave a stale entry. The transcript and the composer share one reading column (`.transcript-column`
  / `.composer-column`, ~760px): the scroller stays full width so its scrollbar keeps to the panel's edge.
- `paneSession.ts` has no unit tests, so behaviour there is covered by `scripts/smoke-desktop.mjs`.
  `dom/` can now be tested: `test/helpers/domStub.ts` is a hand-written stand-in for the `document`
  members `dom/dom.ts`, `dom/controls.ts` and `dom/icons.ts` use, plus a `Node` binding (a `focusout`
  handler's `instanceof Node` is a ReferenceError without it), plus stand-ins for layout it cannot compute
  (`scrollTop`/`scrollHeight`/`clientHeight`, set through `setMetrics`) and for the one inline style the
  renderer writes (`style.height`, with a textarea's `selectionStart`). `test/rendererWelcomeView.test.ts`,
  `test/rendererSettingsView.test.ts` and `test/rendererTranscriptView.test.ts` are the pattern (install per
  test, assert through the returned handle, and keep the source-scan guard that fails when a helper grows a
  DOM call the stub lacks — it reads comments too). The scan covers `document` members only, so element
  members the stub fakes are unguarded. Still prefer moving a decision into `model/` when it can be tested
  directly.
- `app.ts`'s **top-level order is load-bearing**: the transport (`mux` / `shellClient`) must be built before
  the theme block, because `applyResolvedTheme` runs at module top level and tells the main process to
  repaint the native overlay. Reading a `const` still in its dead zone there throws before any view is
  constructed, and the window opens showing nothing but `index.html` — no typecheck program sees it (`const`
  hoisting makes the forward reference legal). `test/rendererBoot.test.ts` is the guard: it boots the real
  esbuild bundle against `helpers/domStub.ts` plus a bridge that answers `panes`, and asserts the title bar
  and sidebar are non-empty. Any test importing that stub needs the DOM lib, so it belongs in
  `tsconfig.domtest.json`'s include and the base `exclude` — `rendererImports.test.ts` checks both lists.

## Conventions and patches

- Use `.js` extensions for relative imports.
- Import schemas from `zod/v3` and keep them strict.
- Prefer pure functions with direct tests over rendering-driven tests when possible.
- Keep comments concise and reserve them for non-obvious constraints or ordering requirements.
- Reset project/session/environment caches in tests when changing their inputs.
- `postinstall` applies the paired `ink+7.0.6.patch` and `wrap-ansi+10.0.0.patch`; keep both together.
  `test/tuiInkPatch.test.ts` covers the patched behavior.
- Keep `AGENTS.md` and `CLAUDE.md` synchronized except for their title and first guidance sentence.
  `todo.md` tracks desktop-port work.
