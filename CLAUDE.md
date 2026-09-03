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
- Startup always lands in a **new empty session**. `main.ts ensureProject` (not `openProject`) is the only
  way a project comes into existence: it bootstraps, registers the root in `~/.myagent/projects.json`,
  and adopts the bootstrap session as the first pane. Startup picks the root from that registry (the
  project of the most recent session anywhere, else the newest registered root) and never treats bare
  `process.cwd()` as a project; `--cwd=`/second-instance directories are explicit and still open.
  The registry is in **added order** (first added first) and `recordProjectOpen` appends rather than
  hoists: it is also the sidebar's group order, so re-opening a project must never move its row.
- The home directory is the **global workspace** (display name 最近): sessions land in
  `~/.myagent/sessions`, and both `loadMergedSettings` and `ConfigService` must skip the project layer
  when it is the user layer (same file, double merge). `hello` carries `projectIsGlobal`; the renderer
  must not string-match the display name.
- The sidebar lists **every added project** (the registry, read live) plus open projects plus the global
  workspace — closed projects come from a read-only index peek, never a bootstrapped runtime.
  `open-session`/`delete-session`/`rename-session` on a registered-but-closed root bootstrap on demand
  (over the named session) or use a transient `SessionStore`. `open-session` also resolves the home root
  explicitly — it is not a registry member — and `list-sessions` carries `globalRoot` whether or not the
  global group earned a row, because that is how the renderer names it without matching `最近`. Sessions with no input and no output are
  invisible: history rows need `messageCount > 0`, and lane-only rows need the pane's `hasConversation`.
- A **project outlives its sessions**. An added project keeps its group with nothing under it; only the
  global workspace has to earn its row (open, or with sessions). `sidebarView` drops an empty group for a
  *search* miss and nothing else. `remove-project` is the only way a project row goes away: it detaches
  the project's lanes and calls `onForgetProject` (registry only, no files), refuses the global
  workspace, and — like `delete-session` — defers the last-lane exit and opens a global-workspace draft
  rather than letting `onAllLanesClosed` quit the app.

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
- Thinking is the `thinking` setting, read in `createRuntime` and handed to the loop and the Agent
  tool: unset means `{ type: 'adaptive' }`, `false` means `{ type: 'disabled' }`, which is the only way
  the payload omits the parameter. `/thinking` writes the local layer, reloads settings, and updates the
  live loop; the desktop toggle writes it and rebuilds.

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
- `skills.disabled` is the exception: it is **replaced** layer by layer, so the local layer can switch a
  skill back on. `SkillsService.list()` applies it (fail-open) and `listAll()` does not — that split is
  what lets the settings screen draw a switched-off skill while the prompt, the slash commands and the
  `Skill` tool cannot reach it.
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
- Every settings category except renderer-local `appearance` maps to one wire `scope`. 「技能和 MCP」 is
  `extensions`, and it owns the skill switch, the skill reload and both MCP variants. A skill change
  rebuilds the project's lanes — a runtime is handed the skill list it was built with — and `app.ts` also
  calls `PaneSession.refreshCommands()`, because the composer's completion list is a renderer-side cache.
- Window-level views derive session identity from `WireLaneInfo`. Usage/cost/streaming belongs below the
  composer; model/effort belongs on its chip, permission mode on its pill, and session name in the header.
- The frameless title bar is draggable; every control in it is `no-drag`, and the Windows control strip
  stays empty. `WINDOW_CHROME` is the only color allowed outside `styles.css`; theme changes repaint it.
  Its `height` and `#titlebar`'s CSS height are one number (40px); the smoke's `TITLE_BAR_HEIGHT` pins it,
  and the right padding is the measured Windows control strip, never a guess.
- The settings screen takes the whole window: `#canvas.settings-open` hides the conversation's regions and
  `body.settings-open` hides the sidebar. Anything that puts a conversation on screen leaves it —
  `activateLane` and the `new` sidebar intent both call `leaveSettings()`.
- `body` alone paints the window base — one flat `--surface-base`, no wash gradient; `#titlebar` and
  `#sidebar` stay transparent, while `#canvas` is opaque. Do not introduce `backdrop-filter` or
  `backgroundMaterial`.
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
- The transcript is **two layers of disclosure**: a turn is one activity group (keyed by `turnId`), and
  every step inside opens on its own. `model/transcript.ts` stays DOM-free with an exhaustive
  `applySessionEvent`, and the live path must produce the same groups a replay of those records does. A
  folded body is **absent, not `hidden`** — `.transcript` is `aria-live="polite"` — and
  `dom/transcriptView.ts` reuses entry and step nodes **by id**: the automatic collapse at turn end
  shortens content above the reader, and scroll anchoring only absorbs that while the anchor node
  survives the paint. Nothing may set `overflow-anchor: none`.
- Keeping a node is not enough — it must stay **attached**. Every insertion in the transcript goes through
  `dom/dom.ts`'s `reconcile`, which moves only what changed position; `replaceChildren`/`replace()` there
  pulls every row out of the page and back, which cancels and restarts its CSS animations (`unfold` on an
  open step replayed once per streamed token) and destroys the scroll anchor. A group's own signature is
  the identity of its kept head and steps box for the same reason, and the head reads its disclosure from
  a mutable ref instead of closing over the paint that built it.
- The group head carries a **stable accessible name** (`groupHeaderName`) while its visible, `aria-hidden`
  label counts steps; what is new is said by the current step's head. The bead is the tool step's only
  *visual* status vocabulary (`awaiting-approval`/`running`/`done`/`failed`) and is `aria-hidden` — the
  state reaches the head's accessible name in words, because colour may not be the only carrier. Steps are
  not cards: no third shadow or radius rung, and depth stays two steps.
- Disclosure stores the user's **absolute** answer per group and step id (`model/thinking.ts`), never a
  deviation from a default. The defaults are dynamic (a running turn is open with only its last step open;
  failures open themselves; an awaiting-approval step does not) and are pruned on `transcript-reset`.
- The task panel is a resident in-flow strip inside `.composer-column` above `#composer` — not a
  `#composer-popovers` layer — read-only, drawn during permission requests too, and absent entirely when
  no checklist exists. Tool display strings reach the renderer as the `toolDisplays` DTO projection of
  `src/tools/display.ts`; the renderer must not guess tool input keys.
- Session row CSS order is load-bearing and is the precedence: `:hover`, `.selected` (keyboard cursor),
  `.active` (the session on screen, filled with `--surface-active`), then `.confirming`. `.open` stays on
  the node as data (`aria-selected`, the smoke probes) and must gain no rule — a background lane is not a
  state the user asked to see. Keyboard cursor and delete confirmation remain separate states.
- A project heading is `.project-heading` and its `+` a sibling inside `.project-row` — a `<button>`
  cannot nest one. Its leading glyph says *what the group is* (`folder`, `clock` for the global
  workspace), not where its fold goes. The heading's context menu is drawn *in flow* under the row,
  because `.sidebar-list` is the scroller and an absolute popover there would clip.
  `menuOpen`/`confirmingRemove` must stay in `sidebarRenderSignature`, or the render guard swallows the
  right-click.
- The sidebar's「最近」nav row is a **filter**, not a destination: it opens nothing, stays enabled while a
  blocking dialog is up, keeps only `isGlobal` groups, and is renderer-local — `recentOnly` is never
  persisted and must stay in `sidebarRenderSignature`.
- The rail's width is `--sidebar-width`: `#sidebar`'s `flex-basis` and `.sidebar-shell`'s `width` read the
  same property, `styles.css` declares the default, and `model/sidebarWidth.ts` owns the range and the
  localStorage key. `app.ts` writes it with `setProperty` (the only property TypeScript may write, beside
  the composer's `height`), and `body.resizing` suspends the collapse transition for the drag's duration.
- The welcome Hero's project name opens the **workspace picker** (`model/workspacePicker.ts`), not a
  reveal: another project means a new session *there* (a live session cannot change its cwd), the current
  one reveals its sidebar group, and「不在项目中工作」opens a global-workspace session. Its state is the
  pane's; the workspace list is `app.ts`'s and is read at paint time. `dom/welcomeView.ts` keeps the Hero's
  scaffolding — above all the picker's search input — across repaints, because the empty state repaints
  once per streamed token and a rebuilt input loses the caret.
- Every class passed to `controls.ts`'s `button()` needs a resting-state CSS rule. Update the explicit
  control lists in `rendererStyleTokens.test.ts` where its scan cannot infer coverage.
- Dropdown/popover ancestor chains (`.settings-column`, `.composer-column`, menu shells) must not clip via
  `overflow`. Composer popovers remain absolute above the composer with the established pointer-event and
  z-index layering.
- `--accent-*` does not fill backgrounds except the three named spots — `.settings-toggle.on`, `#submit`,
  and `.session-row.active::before`; keep `ACCENT_FILL_EXCEPTIONS` exact. `--accent-brand` is the weak rung
  (icons, hairlines, indicator bars, switch tracks); anything carrying text uses `--accent-brand-strong`
  over `--on-brand`, and `rendererStyleTokens.test.ts`'s `contrast()` assertions enforce that split.
- Spacing, radius, and type come from tokens: `--space-1..7`, `--radius-lg|md|sm|pill` (20/12/8/pill), and
  the seven `--type-*` rungs — not ad-hoc pixel values. `--font-serif` is display-only and whitelisted to
  the welcome/empty-state hero, the settings section headings, and the two dialog titles.
- Depth is two steps: menus and popovers take `--radius-md` + `--shadow-float` (the focused composer joins
  them), and the two modal panels take `--radius-lg` + `--shadow-modal`. Nothing invents a third.
- Model and effort are one `#chip-runtime` control. Its rows reuse picker decisions and persist changes via
  `run-command`; keep rows stable while switching flyouts and cancel stale opens in `closeMenus()`.
- Short transcripts bottom-align through `.transcript-column { margin-top: auto; flex-shrink: 0; }`; it
  remains the scroller's only child. Do not replace this with `justify-content: flex-end`.
- Dropdown glyphs use `trailingIcon`; `.btn-label` must flex so long labels do not eject the glyph.
- The canvas hairline is an inset `outline`, not a border or box shadow. `#overlay`/`#rewind` stay absolute
  inside the positioned, overflow-hidden canvas and above popovers without giving `#canvas` a z-index.
- Blocking dialogs derive rows/buttons and intents in `model/`. Mouse and keyboard actions share the same
  intent mapping; the backdrop never dismisses a request. Suggestions accept on prevented `mousedown`.
- Only three of the four blocking requests are modal. The **permission** request is drawn in the composer
  (`dom/permissionRequestView.ts` into `#composer-request`), and `#composer.request-open` hides `#input`
  and `#composer-bar` for its duration — so `renderOverlay` must close whichever of the two it is not
  using, and `deactivate()` clears both. It shares `permissionViewModel` and `overlayView.ts`'s
  `actionBar`, and `hasOverlay` still routes keys to `'overlay'`. The sidebar's `awaiting-input` badge
  names itself in words, because a request parked on a background lane is otherwise invisible.
- Screens with key handlers take focus once when opened, not on every render.
- Motion is tokenised (`--motion-fast|base|slow`, `--ease-standard`, `--ease-exit`) in one block at the
  foot of `styles.css`; a transition names a duration token and one of the two curves. Transitions only go on nodes that survive their state change; entrance animations only on
  containers whose existence tracks open/closed — never on transcript items or the two dialog panels,
  which re-render underneath themselves. `@media (prefers-reduced-motion: reduce)` is the sheet's one
  permitted nested at-rule.
- The sidebar fold is a four-state machine (`expanded`/`collapsing`/`collapsed`/`expanding`) decided in
  `renderer/model/` and part of `sidebarRenderSignature`. Content lives in a fixed-width shell inside an
  `overflow: hidden` sidebar, so collapsing never reflows it; unmounting waits for `transitionend` or the
  fallback timer, and each transition clears the previous listener and timer. `#canvas` keeps a constant
  `margin-left`, so `flex-basis` is the fold's only animated property. Project groups fold the same way
  via `grid-template-rows: 1fr → 0fr` over reused `.project-group`/`.project-body` nodes; a row inside a
  folding group has index -1, which is not the "no cursor" -1.
- Focus rings on containers use `:focus-visible`; only real text inputs paint on `:focus`.
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
