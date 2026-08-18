# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

Hanekawa (package `myagent`) is a self-hosted terminal coding agent: an Ink/React TUI over a
provider-agnostic agent loop, with session persistence, prompt-cache-aware compaction, permission-gated
tools, subagents, skills, and MCP. `README.md` documents user-facing behavior; this file covers what you
need to *change* the code.

## Commands

```bash
npm install                        # postinstall runs patch-package (required, see Patches)
npm run dev:tui                    # start the TUI; also: resume <id> | --continue | c | list
npm run typecheck                  # base + tsconfig.preload.json + tsconfig.renderer.json
npm run build                      # tsc -p tsconfig.build.json → dist/ (Electron main only)
npm run build:desktop              # build + esbuild preload/renderer bundles + copy index.html
npm run start:desktop              # electron . (needs a real display)
npm run test                       # full suite: 1951 tests / 39 suites, ~45s
node --import tsx --test test/compact.test.ts          # single file (space-separate several)
node --import tsx --test --test-name-pattern "cache break" test/cacheBreakDetection.test.ts
```

Node 22+, no lint, no build for development. Tests are `node:test` + `node:assert`, flat in `test/`, with
`fast-check` for `*.property.test.ts` and `ink-testing-library` for the few render tests.

**Four tsconfigs, coupled.** `tsconfig.build.json` sets `rootDir: "src"` (`src/x.ts` → `dist/x.js`);
without it tsc emits into `dist/src/**` and every `import.meta.url`-relative path changes meaning
(`test/distBuild.test.ts` pins this). The base `lib` has no DOM, so browser-side files
(`src/desktop/renderer/**`, `src/desktop/preload.ts`) sit in its `exclude`. `tsconfig.preload.json` /
`tsconfig.renderer.json` add the DOM libs for exactly those files and **must declare their own `exclude`**
(inherited), or both programs come up empty and report a false green.

## Architecture

### Layering

`prompts/` is a leaf — never import `harness/` from it (cycle). `services/` depends on `tools/`, not the
reverse. The harness talks to the `RecordStream` port (`src/sessions/recordStream.ts`), never to
`SessionStore` directly.

```
tui/ (Ink)  →  harness/ (loop, toolRunner, permissions, contextBuilder)  →  config/providers/
                     ↕                          ↓
              sessions/ (JSONL)            prompts/ (budget, composer)      tools/   services/
```

### Runtime tiers — `src/runtime/types.ts`, `sessionScope.ts`, `sessionWorkspace.ts`

- **`ProjectRuntime`** — one per `cwd`: `config`, `store`, `ToolRegistry`, `CommandRegistry`, MCP
  connections, `BackgroundTaskRegistry`, reload functions, `shutdown`.
- **`SessionScope`** — one per conversation: `bridges`, `permissionGate`, `promptSections`,
  `createRuntime`. Sharing any across sessions is a bug: bridges have one handler slot per proxy; the
  gate owns mode + session rules + denial counters; `promptSections` caches `# Environment`, which embeds
  the model name.
- **`SessionPane`** — a scope plus the `RuntimeSlot` and `SessionController` driving it; the unit a
  desktop tab owns.

`bootstrap()` returns `RuntimeHost = ProjectRuntime & SessionScope` for one-session shells; `SessionHost`
takes the halves separately. `reloadSettings()` fans out to every open scope; `shutdown()` disposes all
scopes and is the only thing that stops background tasks.

`SessionWorkspace` rules:

- **One pane per session** — otherwise two `AgentLoop`s append to one JSONL and two `CheckpointService`s
  snapshot one worktree. `open()` hands back the pane already showing it; `switchPane()` refuses before
  swapping. `paneForSession` scans (no index); `SessionPane.getSession()` reads the controller so the
  answer survives `/clear` and `/resume` (`scope.session` does not move).
- **`close()` order is fixed:** `interrupt('exit')` → controller → slot → scope; idempotent; scope last so
  draining bridges releases a turn parked on a permission prompt. Closing a pane does not stop its
  background tasks.
- `switchPane`/`clearPane` wrap `sessionSwitch.ts`, the only copy of that choreography. Panes own no
  `SessionRecordLedger` — results come back raw for the caller to rebase.

**N sessions per project and N projects per process are both safe.** Module-level project-scoped state
partitions on `agentCacheSource(sessionId, cwd)`, `compact.ts`'s `circuitKey`, the content-hashed
`toolSchemaCache`, `contextByCwd`, `resolvedCwdCache`, `sessionMemory`'s `sessionStates`; the slash-command
registry and fixed-literal cache sources are instance/root-bound. `test/multiProject.test.ts` keeps this
true. Still missing: a shell that opens a second project (`todo.md`).

### The turn loop — `src/harness/loop.ts`

`AgentLoop.run(userInput, signal?, messageId?, overrides?)` composes `ContextBuilder`, `ToolRunner`,
`RecordStream`, `ModelProvider`; everything crossing those seams is a `SessionRecord`
(`src/harness/types.ts`). Max 100 iterations.

- **`run()` and `runTool()` funnel through `enqueue()`** — one in-flight slot guarding `recordsCache`,
  `toolContext`, the record stream; it swallows the prior rejection by design.
- **Two abort channels.** `ToolRunner.run` *resolves* with a `tool_result` carrying
  `errorCode === 'aborted'` rather than throwing — any new path awaiting it must convert that to a thrown
  `AbortError`. `signal.reason === 'user-cancel'` is the user-interrupt sentinel.
- **Any model switch sets `stripAllThinkingBlocksFromRequests` permanently** and must
  `clearCachedSections()` (Environment embeds the model name), reset cache-break detection and the
  cache-edit manager. Same after compaction.
- **`applyProgressiveCompaction()` returning true forces a token recount from scratch.**

### Context assembly — `src/harness/contextBuilder.ts`, `src/harness/sections.ts`

System blocks in order: static literals (`SystemPromptSectionCache`) → project context →
`# Environment` → `# Available skills` → `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` sentinel (only if dynamic blocks
exist) → custom system → critical reminder → plan/acceptEdits reminder; everything before the sentinel is
cacheable. `built.system` strips the sentinel; the Anthropic path uses `systemBlocks` +
`splitSystemForCaching` — not interchangeable. The current date lives in a *user* message so midnight
doesn't bust the cache. All injected context goes through `wrapInSystemReminder` (`systemReminder.ts`).

### Compaction × prompt caching

`src/prompts/budget.ts` owns token accounting: `effective = contextWindow − summaryOutputTokens(20k)`;
auto-compact at `min(0.93 × effective, effective − 13k)`; micro-compact at `0.9 × effective`.
`countTextTokens` is a deliberately conservative heuristic — swapping in a real tokenizer shifts every
threshold. `DEFAULT_CONTEXT_MANAGEMENT` is duplicated as literals in `DEFAULT_CONFIG`
(`src/config/service.ts`); keep in sync.

- `compact.ts` never summarizes the most recent user message; failures fail-open with a circuit breaker
  (3 strikes → disabled for the session); session-memory compaction (no LLM) is tried first.
- `selectContextItemsForContext` ends with `repairToolPairing` — orphaned tool_use/tool_result pairs make
  the Anthropic API 400. On-disk equivalent: `src/sessions/invariants.ts` (`/repair`).
- **Ratio-based micro-compaction never mutates local records** — it emits Anthropic `cache_edits`.
  `CacheEditManager` exists only when `provider.supportsCacheEdits && getPromptCachingEnabled(model)`;
  `pinEdits()` is wired but never called.
- **Cache-break detection lives in the provider** (`cacheBreakDetection.ts`); the loop only emits the
  metric. Every minting helper folds a digest of the project root *into the source string itself*
  (`agentCacheSource`/`planCacheSource`/`forkCacheSource`/`compactCacheSource`/`toolUseSummaryCacheSource`)
  — the provider has no cwd, and reusing a source across streams poisons the baseline. Use
  `displayCacheSource()` for literal comparisons or user-visible strings (`source === 'compact'` is false
  once a root is bound); the source is hashed into `prompt_cache_key` on the OpenAI path.

### Tools — `src/tools/`

`Tool` lives in `src/harness/types.ts`. `riskLevel` is consumed only by the permission gate;
`isReadOnly`/`isDestructive` drive batching and subagent tool filtering.

`src/tools/index.ts` is **hand-maintained** — no auto-discovery. Register new tools in
`getBuiltinTools()`; that array also feeds `src/tools/display.ts`, so a tool missing there silently loses
every TUI display hook. Set `searchHint` and `maxResultSizeChars` where relevant; `shouldDefer: true`
hides behind ToolSearch. Subdirectory tools split `constants.ts` / `prompt.ts` / `<Name>Tool.ts`.
`TASK_*_TOOL_NAME` and `isDeferredTool` exist in two places — keep in sync.

**Batching lives in the loop, not the runner:** `runToolCallsInOrder` groups *contiguous* safe calls
(`Promise.allSettled`); safe = not `isDestructive` and (`isConcurrencySafeInput(input)` or both
`isConcurrencySafe` and `isReadOnly`). `ToolRunner.run` always emits `tool_approval` and always emits
`tool_result` + `postToolUse` on every early-return path (invalid input, denial, abort, hook block).

**Subagents** (`agentTool.ts`) build a nested harness per run — own `PermissionGate`, `ToolRunner`,
`ContextBuilder`, `AgentLoop`, `MemoryRecordStream` (foreground) / `SidechainRecordStream` (background).
The `Agent` tool is per-runtime, not in `getBuiltinTools()`; `tui.tsx` appends it last. Built-ins
`general`/`fork`/`explore`/`plan` are overridable via `.myagent/agents/`.

### Permissions — `src/harness/permissions.ts`

Modes: `default | plan | acceptEdits | bypass | readonly`. Even in `bypass`, deny/ask rules,
`checkWindowsPathSafety` findings and `PROTECTED_PATHS` (`.git`, `.vscode`, `.idea`, `.myagent`) still
prompt.

**Rule matching is asymmetric:** Bash `deny`/`ask` rules strip env prefixes and match the whole command
*and every segment*; `allow` rules match the whole command only. "Always allow" refuses compound commands
unless every segment yields an identical prefix (`shellRuleMatching.ts`), and its side effect fires
*before* the prompt resolves. Anti-loop machinery escalates silent auto-denials back into prompts. Mode
changes go through `applyPermissionModeTransition` (`src/runtime/permissionMode.ts`), which couples
`PermissionGate` ↔ `PlanModeManager`.

**`ToolRunner.run` does not pass its abort signal into `PermissionGate.approve`** — cancelling a turn
never unblocks a pending prompt. Bridge draining, pane close order and renderer Escape ordering exist
because of this.

### Providers — `src/config/`

Layers: `endpoints` ← `models` ← `profiles` (`fast|balanced|powerful`); `Routing` maps roles (`main`,
`plan`, `compact`, `subagent[type]`) to a tier or `inherit`.

Settings: `~/.myagent/settings.json` → `<cwd>/.myagent/settings.json` → legacy `mcp.json` →
`settings.local.json` (permissions/hooks arrays **concatenate**, scalars last-wins); then `config.json`
wins over settings, global before project. `ConfigService.save()` writes the project file only if it
already exists (else global) so keys don't scatter; `{ globalConfigPath: null }` drops the shared layer.
Validation is hand-rolled.

Add providers via `PROVIDER_FACTORIES` (`providers/registry.ts`). **`nativeAnthropic` =
`baseUrl.includes('anthropic.com')`** (undefined = native) and gates cache_control, cache_edits,
`context_management`, betas, `defer_loading` — proxies fall back to inline tool schemas. **Model fallback
is a retry-layer signal:** overload exhaustion throws `FallbackTriggeredError` (`retry.ts`), caught by the
loop to call `activateFallback()`.

`anthropicPayload.ts` folds records into content blocks with cache markers (pruned to 4 by
`finalizeAnthropicCacheControl`); `openaiPayload.ts` emits flat role messages with a hashed
`prompt_cache_key`. Both route zod → JSON Schema through `harness/toolApiSchema.ts` (session-scoped cache
so schema churn doesn't bust the prompt cache).

### TUI — `src/tui/`

`entrypoints/tui.tsx` is the only wiring point; startup order matters (focus filter before Ink takes
stdin; MCP trust prompts before Ink owns stdin). It builds a `RuntimeSlot` + `SessionController` via
`createSessionPane(host, host)` and hands them to `App` — a different shell replaces only the view layer.
`App.tsx` is the single stateful shell; `useAgentLoop.ts` renders the controller's events;
`useKeyboardShortcuts.ts` is the one global key handler.

- **Model switches, `/clear` and resume replace the runtime** via `RuntimeSlot.replace`
  (`src/runtime/runtimeSlot.ts`) — install new *before* disposing old. The slot owns the effort level.
  **Runtime tool arrays are mutated in place** (`splice`) so MCP reconnects reach live subagent closures;
  never swap by identity.
- **`SessionController` (`src/runtime/sessionController.ts`) owns the turn lifecycle** and the three
  `RecordProxy` handlers — a UI subscribes via `onEvent`, never `setHandler` (records get handled twice).
  `turn-end` carries `aborted` (the signal), not "did it throw". Only `transcript-reset` with
  `bumpGeneration` remounts `<Static>`; a rollback must not.
- **Session switches go through `sessionSwitch.ts`**, not just `controller.retarget` — it rebuilds the
  runtime (replace *last*), restores background tasks, reconciles orphaned agents. Its `beforeApply` hook
  (MessageQueue rebind) must run before `RuntimeSlot.replace`; it can't run earlier, since the new session
  id exists only after `createDraft()`.
- **Only the permission bridge parks** — `createPromptProxy` queues until a UI attaches; the other three
  answer immediately. The five fallbacks are deliberately asymmetric (permission/AskUserQuestion/exit-plan
  reject, **enter-plan approves**, record drops) — don't unify. UI teardown must settle in-flight requests.
- **`transcript.ts`: Ink `<Static>` output cannot be retracted** once a later sibling is emitted —
  `staticItems`/`liveItems`/`liveSystemItems` promote in strict order; hidden tools (ToolSearch, plan
  tools, Task*, Skill, AskUserQuestion) render nothing but mark group boundaries.
- **`layout.ts` hand-duplicates the render components' row arithmetic** — change a height without
  `estimate*Rows` and you get flicker/overdraw (`test/tuiLayout.test.ts`).
- Import **`../ink.js`, not `ink`**, where cursor/frame state matters (`src/tui/ink.tsx` façade).
- Colors only from the frozen `theme` (`src/tui/theme.ts`) — add semantic keys, never literals
  (`test/tuiTheme.test.ts` asserts source level too). Animation uses the shared 16ms clock
  (`clock/ClockContext.tsx`) that pauses on focus loss/overlay; no `setInterval` in components.
- **Message queue:** a `MessageQueue` instance — owned by `App` in the TUI, `SessionHost` on the desktop —
  persisted as `message_queue` records; Enter enqueues, a guarded effect pumps (guard: `canPumpQueue`,
  `src/runtime/queuePump.ts`).
- **Slash commands** (`src/commands/`) are a per-project `CommandRegistry` of `{name, description, run}`
  that render nothing; effects go through optional `CommandContext` callbacks, so commands must tolerate
  `undefined` ones. `/help` is `createHelpCommand(registry)`. Skill commands are prompt macros with
  per-invocation model/effort/tool overrides; built-ins shadow same-named skills. Skill entries go in
  through `registerSkill()` and are dropped by `clearSkills()` at the top of every `registerSkillCommands`
  pass — a reload has to *replace* them, since `has()` cannot tell a built-in from last pass's own entry.

### The process boundary — `src/runtime/protocol/`

No Electron imports. `SessionHost` owns the runtime, speaks `HostEvent`/`HostCommand` over a
`RuntimeChannel`, taking `project` and `scope` separately. `SessionClient` mirrors `SessionController`
for a renderer.

- **Wire types replace what can't be cloned:** `WireRunOverrides` (model *key*, never a live provider),
  `WireRuntimeSnapshot` (`apiKey` stripped), `PermissionRequestDto` (`toolName`+`riskLevel` instead of the
  `Tool`; `onAlwaysAllow` is a response flag the host fires *before* resolving). Everything must survive
  `structuredClone` — `createMemoryChannelPair` clones on every post so violations fail loudly.
- **`SessionClient` field-diffs before swapping snapshot, task list, queue or cost** —
  `SessionController.publish` compares by reference, but every deserialized message is a fresh object
  graph.
- **Inbound is validated, outbound isn't.** `parseHostCommand` (`commandSchema.ts`) runs a `.strict()`
  union over all 34 `HostCommand` variants; kept honest by a keyed `satisfies` table (fails *by name*) and
  a mutual-assignability assertion. A malformed `ui-response` is settled with that kind's own fallback —
  nothing else releases the pending prompt. Traps: `PERMISSION_MODES` is the Shift+Tab *cycle order*
  (4 values, no `'readonly'`), not the mode set; `set-effort.level` is `z.string()` (raw token budget as
  decimal string) — only `WireRunOverrides.effort` is the enum.
- **`execute()` exhaustiveness is enforced by `assertNever`** — an unhandled variant otherwise compiles
  clean and answers a no-op as success. No `default` branch; don't delete it.
- **DTOs carry derived data so the renderer never imports `harness/`.** `toPermissionDto`
  (`permissionDto.ts`) is shared with the TUI's `usePermission`, so both dialogs render identical input;
  `WireModelsResult.pickerOptions` and snapshot `cost` go through `resolveUsageWithCost` — the one
  projection behind `/cost` in both shells; absent (not zero) when unpriced. **Project from `ModelConfig`
  field by field, never spread** — `resolveModel` folds `apiKey`/`baseUrl` into what it returns.
- **The desktop's message queue lives in `SessionHost`** (the TUI's in `App.tsx`): persisted via
  `store.appendRecord`, and the pump gate reads host-only state. `canPumpQueue`: `uiBlocked =
  pendingKinds.size > 0` — blocking requests, not open panels. `pumpQueue()` is detached, re-checks in its
  own `finally`; triggers: enqueue, `postSnapshot`, `askUi` finally. **No `dequeue` command** — a client
  popping would race the pump. Session switches rebind via `beforeApply` (`migrateTo` for `/clear`,
  `reset` for `/resume`).
- **`SessionController.submit` rejects a concurrent turn** — that guard is what makes queueing safe
  (everything after it assigns `this.abortController`). It throws rather than no-ops; callers catch. The
  `try` opens right after `streaming = true` so the `finally` covers `publish()` too.
- **`client.ts` must not *value*-import `harness/`, `services/`, `sessions/`, `commands/`**
  (`test/protocolClientParity.test.ts`) — the last drags the filesystem in via `skills.ts`. Renderers
  deep-import `protocol/client.js`; the barrel pulls `node:fs`.
- **Slash commands run host-side; `CommandEffect` is what can't.** `createHostCommandContext`
  (`commandContext.ts`) satisfies the hostable members; the rest leave as `write-line` /
  `open-command-view` / `open-surface` effects. Hence `run-command` takes the raw line and pushes effects
  *before* its `reply` — not plain request/response. `COMMAND_CONTEXT_COVERAGE` is a keyed `satisfies`
  table, so a new `CommandContext` member fails the build *by name*. The context is rebuilt per command
  and reads session/records through getters (`/model`, `/clear` replace both mid-command).
  `WireCommandInfo` is built field by field — Electron IPC drops functions *silently*.
- **`/rewind` writes end with `invalidateRecordsCache()` → `controller.reload()` → `ledger.rebase()`** —
  drop one and stale records resurface. `restore-code-and-conversation` = `restore-code` then
  `truncate-session`, composed by the caller.
- **Pane commands are the only host reach past its own session.** `open-pane`/`close-pane`/`list-panes`
  work off `PaneRegistry`, declared *structurally*. One pane per session; `onPaneOpened`/`onPaneClosed`
  fire for *resolved* panes, so shell callbacks must be idempotent.
- **`paneId` is the pane's *current* session id — not a stable key** (`/clear`/`/resume` move it).
  `broadcastPaneList()` fires only from open/close and posts to this host's channel alone, so the shell
  owns the cross-window bookkeeping: `main.ts` keys its `panes` map by `BrowserWindow.id` (never moves, so
  no re-keying on `session-changed`), closes over the window entry in `onPaneClosed` (that callback's
  `paneId` is the host's *current* session id and never matches an open-time key), and fans `pane-list` out
  itself via `broadcastPaneListToOthers` — skipping the initiator (host already delivered its update) and
  firing from the OS `'closed'` path too, which bypasses host.

### Electron shell — `src/desktop/`

One `BrowserWindow` per pane: `bootstrap()` → `new SessionWorkspace(host)` → per window a `SessionPane` +
channel + `SessionHost`. `preload.ts` exposes only `{send, onMessage, close}` on `window.hanekawa`.
**A tab is a window:** every tab bar renders the whole workspace; switching = `open-pane({sessionId})`
resolving to an existing pane → focus call. N channels share one `ipcMain`, claiming traffic by
`event.sender` (`test/electronChannel.test.ts`).

Transport interfaces (`ipc/electronChannel.ts`) are **structural, not imported from `electron`** —
loadable from plain-node tests. Each rule below was a launch-blocking bug `tsc` couldn't see:

- **Assign, don't cast:** `const mainIpc: MainSideIpc = ipcMain` — the assignment *is* the check;
  `Satisfied<Real, Ours>` compile-time assertions are the second net.
- **`webContents` is an `EventEmitter`** (`.on`/`.removeListener`); the DOM `window` is an `EventTarget`.
  **`ipcMain.on`/`ipcRenderer.on` return `this`, not an unsubscriber** — teardown goes through
  `removeListener` on every close path, or listeners leak on the process-wide `ipcMain` one per pane.
- **Channel + `SessionHost` are wired before `loadFile`**, no handshake (`nodeChannel.ts` does need
  `__ready`). If any constructor subscription ever fires on registration, revisit this ordering.
- **`dist/desktop/` paths anchor to the module's own directory** — never count `..` (emitted depth ≠
  source depth).
- **`before-quit` must `preventDefault()` and await teardown** — `sessionHost.dispose()` → each
  `pane.close()` → the single shared `host.shutdown()` — then re-`quit()` behind a flag.
- **Nothing in `main.ts` is tested** (`app.requestSingleInstanceLock()` at module top level throws under
  plain node); `test/desktopMain.test.ts` drives channel + host + client with a fake `PaneRegistry`
  instead. Push decisions into `SessionHost` or `model/` modules rather than adding here.
- **One implementation per side** — the renderer channel is `renderer/bridgeChannel.ts`, used by both
  `app.ts` and the tests.

### The renderer — `src/desktop/renderer/`

**`model/` + `dom/` split is a correctness constraint:** `model/*` holds every decision (dialog options,
keystroke → answer, how a `stream` event folds into the transcript) as pure functions; `dom/*` and
`app.ts` only build nodes/listeners. No DOM in the test runner, so decisions must be DOM-free — `model/`
modules take structural key shapes (`{ key, shiftKey }`), never `KeyboardEvent`/`HTMLElement`.

**Node globals are invisible to both typecheck passes in renderer code:** the renderer program pulls ~130
host files via the wire types, so `@types/node` globals are in scope despite `"types": []` — `process.env`
compiles clean, then `ReferenceError`s in Chromium. `test/rendererImports.test.ts` enforces: no value
import of `harness/|services/|sessions/|commands/|tui/`, an import allowlist, no Node global.
`node:crypto` alone is permitted (aliased to `nodeCryptoShim.ts` by `build:desktop`).

- **Escape answers an open dialog before it interrupts** (`model/keymap.ts`) — a turn parked on a
  permission prompt isn't released by interrupting.
- **`/rewind` panel is modal but not blocking**, fixing its `resolveKey` rank: below `hasOverlay` (holds
  the agent loop), above dropdown/dismissible panel/composer (its confirm options destroy work). Own
  container (`#rewind`, z-index 5 under `#overlay`'s 10) so prompts draw on top.
  `runtime/rewindPresentation.ts` owns the option slots, outcome strings and `rewindStepsFor` — whose
  truncate-*then*-revert order is the only reason `rewindPartialFailureMessage` exists. `runRewind`
  (`model/rewindPanel.ts`) must not rebuild the transcript (`SessionHost.afterRewind()` already pushed a
  `transcript-reset`); `app.ts` closes the panel on session change.
- **`SUPPORTED_SURFACES` = surfaces drawn as a row list**, not what this shell handles — `rewind-panel`
  resolves by name before `isSupportedSurface`; `provider-panel` is the one ignored by name.
- **Tab-bar chords resolve *before* the keymap** — only safe because `tabBarKeyToIntent`
  (`model/tabBar.ts`) returns `'none'` unless ctrl/meta is held. An unmodified key would silently shadow
  every dialog.
- **A blocking request must always be answered** — `SessionClient.answer` try/catches handlers and falls
  back to `UI_REQUEST_FALLBACKS[kind]()`; otherwise a throwing dialog wedges the loop for the life of the
  process.
- **Enter mid-turn queues rather than sends; key path and button must agree** — the button stays
  *enabled* while streaming and relabels to "Queue". No per-row queue remove (no `dequeue` on the wire);
  Clear is a button so Escape keeps two meanings, not three. Dropdown open: Enter = accept **and** run,
  Tab = accept-only — **except file mentions**, where Enter only accepts (`@src/foo.ts` is a half-written
  sentence; `ShellState.completions` is `'none' | 'command' | 'file'` for exactly this). Slash commands
  are never queued.
- **`@` completion splits by dependency:** pure half in `runtime/suggestions/atToken.ts`
  (renderer-allowlisted); `fileSuggestions.ts` needs `node:fs` + fuse.js, so search runs host-side over
  `file-suggestions` — and **nothing orders the answers**: `model/completion.ts` carries a monotonic
  `seq`; `applyFileResponse` drops anything stale. Every transition bumps `seq`.
- **A picker row's action is a slash-command line**, not the `SessionClient` method — `/model <tier>` via
  `run-command` writes the tier back to config; `client.setModel` would silently drop that persistence.
  `resume-picker` uses `open-pane` (`/resume` takes no argument). Disabled rows carry no action;
  `moveSurfaceSelection` steps over them.
- **Picker navigation is gated on an empty composer** — typing after opening `/model` means "send". Also
  makes panel and dropdown mutually exclusive by construction.
- **Shared presentation** (`runtime/permissionPresentation.ts`, `planPresentation.ts`,
  `rewindPresentation.ts`) is pure with type-only cross-layer imports — one value import breaks the
  renderer bundle. `test/rewindPresentation.test.ts` asserts *function identity* so a re-export can't
  fork.
- **No `innerHTML`; markdown is parsed, never rendered to HTML.** `model/markdown.ts` uses marked's
  **lexer** into its own `MdBlock`/`MdInline` union; `dom/markdownView.ts` walks it with `el()`. Three
  downgrades happen at *parse* time: `html` tokens → literal text; non-http(s)/mailto links lose anchors;
  images → `alt (url)` text. Only assistant messages and plan bodies render as markdown. The FNV-1a LRU
  is a deliberate second copy of `src/tui/markdown.ts`'s. Anchors carry `target="_blank"` →
  `guardNavigation()` in `desktop/main.ts` → `shell.openExternal`.

### Sessions & state — `src/sessions/`, `.myagent/`

Persistent state lives under `<cwd>/.myagent/` (gitignored) via `src/utils/paths.ts`, except
`~/.myagent/settings.json` and `~/.myagent/config.json` (`getGlobalConfigPath()`); sessions, skills and
plans stay per-project.

`SessionStore` writes `<id>.jsonl` append-only; rewrites via `writeFileAtomic` (tmp + rename). **New
sessions are in-memory drafts** — disk is untouched until the first `message` record.
`messageCount`/`title`/`updatedAt` are derived; `compactFailureCount`/`denialState` must be preserved on
rewrites. Class-level locks serialize in-process mutations; `fileLock.ts` adds an `O_EXCL` advisory lock
for cross-process safety. Reads self-heal and report `SessionDiagnostic[]` rather than throwing.

`services/checkpoint/` snapshots the working tree each turn into a **shadow git repo** at
`.myagent/shadow-git/<sessionId>` (`core.worktree` → project root), so `/rewind` never touches the user's
repo.

## Conventions

- **`import { z } from 'zod/v3'`** — never bare `zod`. Schemas are `.strict()`.
- **Every relative import carries a `.js` extension** (NodeNext ESM, zero exceptions in `src/`).
- Prefer pure functions tested directly over component rendering.
- Reset module-level env caches in tests (`resetToolSearchCache`, `clearProjectContextCache`, …).
- Commit messages: match the surrounding history or keep it short.
- `AGENTS.md` is a byte-for-byte mirror of this file apart from its title and guidance line; edit both
  together. `todo.md` tracks desktop-port progress and open work.

## Patches

`postinstall` runs patch-package; `ink` is pinned to `7.0.6`. `ink+7.0.6.patch`: CJK/full-width line
breaking with kinsoku rules (injected U+200B), a cursor suffix fix, Windows Terminal resize reflow
(`WT_SESSION`), a reconciler use-after-free fix. **`wrap-ansi+10.0.0.patch` is its required counterpart**
(teaches `wrap-ansi` to split on U+200B) — change one without the other and wrapping breaks.
`test/tuiInkPatch.test.ts` fails if the patches aren't applied.
