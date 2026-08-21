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
npm run build:desktop              # build + esbuild preload/renderer bundles + copy index.html/styles.css
npm run start:desktop              # electron . (needs a real display)
npm run test                       # full suite: 2096 tests / 41 suites, ~42s
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
(inherited), or both programs come up empty and report a false green. `typescript` itself is pinned exact
(`7.0.2`, same style as `ink`) — tsc is the emit toolchain, so a drifting major silently changes `dist/`;
bump it deliberately, with typecheck + build + full suite as the gate.

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

### Runtime tiers — `src/runtime/types.ts`, `sessionScope.ts`, `sessionWorkspace.ts`, `projectDirectory.ts`

- **`ProjectRuntime`** — one per `cwd`: `config`, `store`, `ToolRegistry`, `CommandRegistry`, MCP
  connections, `BackgroundTaskRegistry`, reload functions, `shutdown`.
- **`SessionScope`** — one per conversation: `bridges`, `permissionGate`, `promptSections`,
  `createRuntime`. Sharing any across sessions is a bug: bridges have one handler slot per proxy; the
  gate owns mode + session rules + denial counters; `promptSections` caches `# Environment`, which embeds
  the model name.
- **`SessionPane`** — a scope plus the `RuntimeSlot` and `SessionController` driving it; the unit a
  desktop tab owns.
- **`ProjectDirectory`** — every open project, and the only pane bookkeeping that spans them.

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

`ProjectDirectory` rules (`projectDirectory.ts`) — the tier a multi-project shell needs, and the reason
`main.ts` holds no module-level project state:

- **Keyed by `projectRootKey(cwd)`** = `resolve` + `normalizeCaseForComparison` (`src/utils/paths.ts`), so
  `C:\Repo` and `c:/repo/` are one project. `add()` **throws** on a duplicate rather than replacing — two
  `ProjectRuntime`s over one `.myagent/` means two `SessionStore`s appending to the same JSONL. A shell
  that wants "open or focus" calls `get()` first.
- **`closeProject()` is `workspace.closeAll()` → `project.shutdown()`**, in that order (the reverse tears
  the tools out from under panes that are still draining), idempotent, and it drops the entry.
- **`describe(panes)` is the one projection onto `WirePaneInfo[]`** and takes the panes to describe rather
  than reading the workspaces: a pane is registered before its window exists, so a shell passes what it
  has windows for and "listed ⇒ focusable" stays true. Panes no open project owns are dropped.
- **Generic over its two halves with the real types as defaults** (`ProjectDirectory<RuntimeHost,
  SessionWorkspace>`), so the shell gets full types and a test writes
  `new ProjectDirectory<FakeProject, FakeWorkspace>()` with **no `as unknown as`** — the constraints still
  check the fake against the members the class calls. `bootstrap()` deliberately stays outside: the shell
  owns the MCP trust prompt and the error dialogs, and hands the assembled halves to `add()`.

**N sessions per project and N projects per process are both safe**, in the core and in the desktop shell.
Module-level project-scoped state partitions on `agentCacheSource(sessionId, cwd)`, `compact.ts`'s
`circuitKey`, the content-hashed `toolSchemaCache`, `contextByCwd`, `resolvedCwdCache`, `sessionMemory`'s
`sessionStates`; the slash-command registry and fixed-literal cache sources are instance/root-bound.
`test/multiProject.test.ts` and `test/projectDirectory.test.ts` keep this true.

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

Layers: `endpoints` ← `models`; `Routing` maps roles (`main`, `plan`, `compact`,
`subagent[type]`) straight to a **model key** or `inherit`. There are no tiers: `DEFAULT_ROUTING` is
all-`inherit`, so plan mode does not auto-upgrade and compaction does not auto-downgrade —
`compactModel` is the escape hatch. A routing value that no longer resolves degrades to `inherit`
rather than failing, and `removeModel` refuses a key routing still points at.

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
  union over all 36 `HostCommand` variants; kept honest by a keyed `satisfies` table (fails *by name*) and
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
- **A host can *create* a pane only in its own project; anything cross-project goes to the shell.**
  `focus-pane` and `open-project` are side-mounted hand-offs — the host touches no workspace and resolves
  no session, it calls `onFocusPane` / `onOpenProject` and answers `{ ok }`. `open-pane` stays
  "create-or-resolve in my project" and was **not** given a `projectRoot` — the desktop shell attaches
  the lane in `onPaneOpened`, so the command needs no cross-project reach. A missing callback **rejects**
  rather than answering `{ ok: true }`, which would look like a focus that silently did nothing. The
  desktop renderer no longer sends `focus-pane` at all (switching is local to the single window); the
  command stays for the TUI, and the desktop's `onFocusPane` maps it onto `requestActivate`.
  `open-project`'s optional `path` is what makes the feature smoke-testable: CDP cannot click a native
  directory dialog.
- **With several projects open the shell, not the host, is the pane-list authority.** `describePanes?`
  (shell-supplied, projected from its *lanes*) wins over the host's own-project `collectPanes()`, which
  stays as the single-project answer the TUI and every fake registry use. `onFocusPane` /
  `onOpenProject` / `describePanes` / `onPaneListChanged` are all **optional for one reason**:
  `test/protocolChildProcess.test.ts` builds its `SessionHostDeps` inside a *string* script, where tsc
  cannot see a required member and the failure would be runtime-only (3a and 3b each sprang that trap).
- **`paneId` is the pane's *current* session id — not a stable key** (`/clear`/`/resume` move it), so a
  session switch is a topology change: `applySessionSwitch` ends with `broadcastPaneList()`, or every tab
  bar keeps the pre-switch id and closing that row fails with "Pane not found". `broadcastPaneList()`
  reaches this host's channel only and then fires `onPaneListChanged` — the desktop shell's cue to
  re-broadcast the lane topology. The **lane key** is the stable handle that survives the switch; the
  shell scans `pane.getSession()` to find it, never a cached id.
- **Lane multiplexing** (`laneChannel.ts`): every message rides one transport inside a
  `{kind: 'data' | 'close', lane, body}` envelope — never a `paneId` field on the 36 commands, which
  would pollute a wire the TUI and `protocolChildProcess` also speak. A lane-level close is a **control
  frame**, because `SessionHost.dispose()` does not close the channel and that frame is what releases
  the peer's pending requests. Inbound frames for an unattached lane are **buffered, bounded** (256;
  overflow closes the lane rather than dropping the frame whose reply would hang), draining in order on
  first attach — the main side builds a lane before the renderer calls `lane(key)`. `lane()` is
  idempotent per key and hands back a *closed* view after `closeLane` (late subscribers fire
  immediately); transport death closes every lane on both sides; a remote close is never echoed.
- **`hello` seeds `SessionClient.session`.** It is an announcement of the bound session, and the desktop
  sidebar derives its active row from `getSession()` — left to the first `session-changed`, no row is
  marked active for the whole first session.

### Electron shell — `src/desktop/`

One `BrowserWindow`, N live panes: `openProject(cwd)` → `bootstrap()` → `new SessionWorkspace(project)` →
`directory.add(...)` → `ensureShell()` (the one window, its transport, the lane mux and the `ShellHost`)
→ the initial lane. Every pane is a **lane** on the window's single IPC transport carrying an untouched
`SessionHost`; the reserved `__shell` lane carries the `ShellHost` — the class every lane/project decision
lives in, because nothing in `main.ts` can be tested (`app.requestSingleInstanceLock()` runs at module
top level). What stays in `main.ts`: the `BrowserWindow`'s lifecycle, the native dialogs, `bootstrap()`.
`preload.ts` exposes only `{send, onMessage, close}` on `window.hanekawa`; the envelope crosses it
untouched.

Two keys, not interchangeable: **lane keys** are minted by `ShellHost` (monotonic, never reused — session
ids travel under `/clear` and `/resume`, lane keys do not), and the project map by `projectRootKey(cwd)`.

`ShellHost` (`shellHost.ts`) rules:

- **`detachLane` is the single exit path** for every way a lane dies (a renderer's `close-pane` through
  `onPaneClosed`, the OS closing the window, a failed `loadFile`, app teardown). It drops the map entry
  *first* — idempotent under re-entry — then disposes the occupant, `mux.closeLane`s (the control frame
  that releases the renderer's pending requests; `SessionHost.dispose()` alone does not close the
  channel), closes the pane, broadcasts. `isQuitting()` makes it skip project shutdown — `teardown()`
  owns the ordering then.
- **A project is shut down when its last lane closes.** `shutdown()` is the only call that stops
  background tasks and MCP clients, so a lane-less project is a set of orphaned child processes. On
  non-darwin the last lane closing quits the app; on darwin the empty window stays (its sidebar still
  offers a new session and "Open project"). Reopening costs a fresh `bootstrap()`, which is also how a
  smoke can *prove* the shutdown happened.
- **Lane creation dedups on pane identity** (`openLane` / `attachPane`): a pane that already has a lane
  is *activated*, never given a second occupant — the single-window equivalent of focusing an existing
  window. `openLane` owns the pane-resolution choreography (`paneForSession` → `store.resolve` →
  `workspace.open`, else `openScope`+`createDraft`+`adopt`) that used to live inline in `main.ts`, and
  `attachPane` is the `onPaneOpened` hand-off. `lanes` is posted before `activate` — one channel is FIFO,
  so the renderer always builds a pane session before being asked to switch to it.
- **`delete-session`'s order is fixed and every step of it is load-bearing.** Capture `store` and `cwd`
  off the entry **first** (step 3 can shut the project down, after which `directory.get()` finds
  nothing) → `store.resolve()` for the **real** id (`SessionStore.delete` takes a prefix, the artifact
  paths do not; the raw wire string would delete the right index entry and miss the rest) →
  `detachLane` if a lane holds it (a pane bound to a vanished JSONL recreates it on the next append) →
  `deleteSessionArtifacts`. **No trailing broadcast:** deleting an open session already broadcast from
  `detachLane`, and deleting a closed one changes no lane — `ShellClient` swallows an identical list by
  design, so the renderer refreshes off the command's own reply.
- **`list-sessions` is history, not topology** — every project's `store.list()` in `ProjectDirectory`
  order, including projects with no lane open. It reuses `SessionMeta` rather than reducing it to a
  sidebar DTO: that type is already on the wire (`WireSessionsResult`, `session-changed`).
- **Generic over `<P, PaneT, W>`** with `RuntimeHost`/`SessionPane`/`SessionWorkspace` defaults and
  `Satisfied<Real, Ours>` compile-time assertions, so `test/desktopShellHost.test.ts` drives a real
  `ProjectDirectory` with plain fakes and **no `as unknown as`** (the `ProjectDirectory` pattern). The
  occupant is deliberately opaque (`{ dispose() }`): production passes a `SessionHost` factory, the test a
  recorder — which is also why renaming a *live* session has no home here yet (it needs the pane's
  controller meta refreshed and a `session-changed` pushed; that lands with 4d's config fan-out). Inbound
  shell commands are zod `.strict()`-validated with a keyed `satisfies` table, the `commandSchema.ts`
  discipline again.

Transport interfaces (`ipc/electronChannel.ts`) are **structural, not imported from `electron`** —
loadable from plain-node tests. Each rule below was a launch-blocking bug `tsc` couldn't see:

- **Assign, don't cast:** `const mainIpc: MainSideIpc = ipcMain` — the assignment *is* the check;
  `Satisfied<Real, Ours>` compile-time assertions are the second net.
- **`webContents` is an `EventEmitter`** (`.on`/`.removeListener`); the DOM `window` is an `EventTarget`.
  **`ipcMain.on`/`ipcRenderer.on` return `this`, not an unsubscriber** — teardown goes through
  `removeListener` on every close path, or listeners leak on the process-wide `ipcMain` one per pane.
- **Channel + mux + hosts are wired before `loadFile`**, no handshake (`nodeChannel.ts` does need
  `__ready`). The renderer still *pulls* its startup topology with `panes` rather than trusting pushes:
  Electron drops IPC posted before the bridge listener exists, so no critical state may depend on an
  early push. The lane mux's pre-attach buffer is what makes late lane attachment lossless.
- **`dist/desktop/` paths anchor to the module's own directory** — never count `..` (emitted depth ≠
  source depth).
- **`before-quit` must `preventDefault()` and await teardown** — every lane's `detachLane('app-quit')` →
  window destroy, then `directory.shutdownAll()` — then re-`quit()` behind a flag.
- **Nothing in `main.ts` is tested** (`app.requestSingleInstanceLock()` at module top level throws under
  plain node); `test/desktopMain.test.ts` drives the real channel adapters, mux, `ShellHost` and
  `SessionHost` lanes end-to-end, and `test/desktopShellHost.test.ts` covers the shell decisions. Push
  decisions into `ShellHost`, `SessionHost`, `ProjectDirectory` or `model/` modules rather than adding
  here.
- **One implementation per side** — the renderer channel is `renderer/bridgeChannel.ts` and the shell
  client is `renderer/shellClient.ts`; both are the shipping implementations the tests drive.

### The renderer — `src/desktop/renderer/`

**`model/` + `dom/` split is a correctness constraint:** `model/*` holds every decision (dialog options,
keystroke → answer, how a `stream` event folds into the transcript) as pure functions; `dom/*`,
`app.ts` and `paneSession.ts` only turn those decisions into nodes and events. No DOM in the test runner,
so decisions must be DOM-free — `model/` modules take structural key shapes (`{ key, shiftKey }`), never
`KeyboardEvent`/`HTMLElement`.

**Node globals are invisible to both typecheck passes in renderer code:** the renderer program pulls ~130
host files via the wire types, so `@types/node` globals are in scope despite `"types": []` — `process.env`
compiles clean, then `ReferenceError`s in Chromium. `test/rendererImports.test.ts` enforces: no value
import of `harness/|services/|sessions/|commands/|tui/`, an import allowlist, no Node global.
`node:crypto` alone is permitted (aliased to `nodeCryptoShim.ts` by `build:desktop`).

- **One `PaneSession` per lane** (`paneSession.ts`): the session client, every dialog/completion/queue
  decision, and its own transcript DOM subtree (`.pane > .transcript + .tool-progress`,
  visibility-toggled — scroll positions survive a switch and nothing repaints). The singleton views
  (status, composer, overlay, surfaces, queue strip) are driven by the *active* pane only; a
  background pane still folds every event into its state — a turn keeps streaming, a permission request
  parks until the user comes back — it just does not paint. The **sidebar is the exception**: every
  pane repaints it, because the badges are per row. `deactivate()` banks the composer draft and
  clears the *paint* (not the state) off the shared panels, so a background pane's dialogs cannot leak
  onto the active one; `activate()` repaints everything once. `app.ts` owns the window: the mux, the
  `ShellClient` on `__shell`, the pane-session map, and the global key handler routing to the active
  pane. A pane's lane channel closing removes its session (the `lanes` event diff is the other half of
  that, and both are idempotent).
- **Escape answers an open dialog before it interrupts** (`model/keymap.ts`) — a turn parked on a
  permission prompt isn't released by interrupting.
- **`/rewind` panel is modal but not blocking**, fixing its `resolveKey` rank: below `hasOverlay` (holds
  the agent loop), above dropdown/dismissible panel/composer (its confirm options destroy work). Own
  container (`#rewind`, z-index 5 under `#overlay`'s 10) so prompts draw on top.
  `runtime/rewindPresentation.ts` owns the option slots, outcome strings and `rewindStepsFor` — whose
  truncate-*then*-revert order is the only reason `rewindPartialFailureMessage` exists. `runRewind`
  (`model/rewindPanel.ts`) must not rebuild the transcript (`SessionHost.afterRewind()` already pushed a
  `transcript-reset`); `paneSession.ts` closes the panel on session change.
- **`SUPPORTED_SURFACES` = surfaces drawn as a row list**, not what this shell handles — `rewind-panel`
  resolves by name before `isSupportedSurface`; `provider-panel` is the one ignored by name.
- **Sidebar chords resolve *before* the keymap** — only safe because `sidebarChordToIntent`
  (`model/sidebar.ts`) returns `'none'` unless ctrl/meta is held. An unmodified key would silently shadow
  every dialog. `Ctrl+Shift+O` (an `'open-project'` intent) is checked before the unshifted letters, since
  a browser reports the shifted key as `'O'`.
- **The sidebar has *two* key entry points and they are not interchangeable.** `sidebarChordToIntent` is
  the global one above; `sidebarKeyToIntent` (arrows/Enter/Escape/Delete) is bound to the sidebar
  *container* and answers `'none'` for anything modified. Scoping it to sidebar focus is what keeps
  arrows out of the composer and lets Escape cancel a pending delete without a `resolveKey` rank — the
  view `stopPropagation()`s a consumed key, or an Enter would activate the row *and* send the composer.
  A pending delete is withdrawn on `focusout`, so it can never become a confirm that is drawn but
  unanswerable.
- **The sidebar lists history, not topology, and the two are unioned.** `list-sessions` (shell lane) is
  the store's answer per project; `ShellClient.getLanes()` says which of those are open, and a lane with
  no file behind it (a fresh draft) still gets a row or the session being typed into disappears. Badges
  (`running`/`awaiting-input`) are *derived* from each pane's `getSnapshot().isStreaming` and
  `shellState().hasOverlay` — **no wire field carries them**, so nothing can go stale. `awaiting-input`
  outranks `running` (a turn parked on a prompt is still streaming). Grouping keeps the old tab bar's
  stable partition (`filter` twice, never a comparator on a boolean), active project first, headings from
  two projects up; `Ctrl+1`–`9` indexes `liveRows`, **not** `rows` — the chord means "switch between live
  panes", and reaching into history would turn a switch into an open.
- **The sidebar view is signature-guarded, and that guard is what makes it affordable.**
  `sidebarRenderSignature` (`model/sidebar.ts`) → `render()` returns early when nothing it draws moved,
  the same field-diff discipline as `SessionClient.applySnapshot` / `ShellClient.applyLanes`. Needed
  because `onShellChanged` fires on *every* snapshot change, and `sameTaskList` compares
  `outputBytes` — so a backgrounded `npm test` would rebuild every history row at output-flush rate, and
  rows are sessions on disk, not messages. **A field drawn but not signed goes stale on screen**;
  `updatedAt` is deliberately unsigned because it is bucketed, never drawn. Collapsed returns before
  building rows at all.
- **Two decisions the sidebar keeps in exactly one place**, both because the second copy diverged:
  `activateRow` (open-or-switch: click and Enter) and `newSessionIntent` (which project a new session
  lands in — the `+` button emitted a rootless intent while `Ctrl+T` resolved one, and `ShellHost` falls
  back to `directory.entries()[0]`, so the button created sessions in the *first-opened* project).
  `state.canCreate` gates the chords as well as the buttons: "key path and button must agree".
- **The renderer's only filesystem reach is `refreshSessions()`**, and it runs on exactly four occasions:
  startup (via the `lanes` event `panes()` fires, not a second call), a `lanes` event, a `turn-end`
  event, and after a delete. `turn-end` rather than watching `isStreaming` for a falling edge — the
  event says it directly and covers aborted turns too. Never on a snapshot tick. Concurrent callers
  coalesce into one extra pass, which is load-bearing: a delete awaits its own refresh, so dropping the
  re-pull would leave the deleted row on screen.
- **`paneBudget.ts` caps resident panes at `DEFAULT_PANE_LIMIT` (4).** Pure: `selectEvictions` orders on a
  monotonic `lastActiveTick` (not a clock — ties are real) and **never returns a pinned lane** (active,
  streaming, or holding an unanswered blocking request). All-pinned deliberately returns *fewer* than the
  excess: going over budget costs memory, evicting a parked prompt drains that bridge with a **denial**
  and fails the user's tool call silently. `app.ts` applies it by `closePane`-ing the chosen lanes, which
  is releasing a runtime, not deleting a session.
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
- **A picker row's action is a slash-command line**, not the `SessionClient` method — `/model <modelKey>`
  via `run-command` writes the choice back to config; `client.setModel` would silently drop that
  persistence.
  `resume-picker` uses `open-pane` (`/resume` takes no argument). Disabled rows carry no action;
  `moveSurfaceSelection` steps over them.
- **Picker navigation is gated on an empty composer** — typing after opening `/model` means "send". Also
  makes panel and dropdown mutually exclusive by construction.
- **Shared presentation** (`runtime/permissionPresentation.ts`, `planPresentation.ts`,
  `rewindPresentation.ts`) is pure with type-only cross-layer imports — one value import breaks the
  renderer bundle. `test/rewindPresentation.test.ts` asserts *function identity* so a re-export can't
  fork.
- **The stylesheet is `renderer/styles.css`, and it is a token system.** Five surfaces
  (`--surface-base`, the sidebar and frame → `--surface-canvas`, the nested rounded panel →
  `--surface-card` → `--surface-hover` → `--surface-active`), three text levels, and five
  `--accent-*` colours that may appear only on `color`/`fill`/`border-*-color` — **never a
  `background`**. `test/rendererStyleTokens.test.ts` parses the sheet and asserts all of it:
  that the surface ladder's luminance is monotonic (the sidebar used to be *lighter* than the
  canvas, which is the inversion 4e made), that every `var(--x)` resolves — the one CSS
  failure that is reported nowhere, since a typo'd custom property just inherits — and that
  no rule outside `:root` spells a colour. Views hold no colour literals at all, and
  `.style.*` is limited to `height` (the composer's autosize, which needs `scrollHeight`).
  Two structural rules: `#canvas` must keep `overflow: hidden` or its scrollbar squares off
  the corner the layout is built on, and `ch` units are legal only in a rule that also
  declares `--font-mono` — `ch` is the width of a `0`, and the chrome font is proportional.
- **The composer is a capsule with an inline action bar**, and its "model · effort" chip is
  where effort lives (stage-4 decision 4: never in settings). Both halves open the *existing*
  pickers by running `/model` and `/effort` through `run-command` — `client.setModel` would
  point the runtime somewhere else and silently drop the persistence `/model` performs, and
  the effort picker is what draws over-ceiling levels disabled-with-a-reason. The status bar
  no longer carries the model: one field, one place. `MAX_COMPOSER_HEIGHT_PX` and the CSS
  `max-height` are two copies on purpose; the JS one is load-bearing.
- **`dom/icons.ts` is the only file that calls `createElementNS`** — `el()` makes HTML
  elements, and an `"svg"` created in the HTML namespace renders nothing at all. Icons
  inherit `currentColor`, which is what keeps accents on `color` rather than on a `fill` the
  style test would have to special-case. The set is a keyed `satisfies`, so a name added to
  `IconName` without a path fails the build instead of drawing an empty box.
- **Shared presentation takes an optional `locale`, defaulting to `'en'`.** The desktop
  passes `'zh'` through `model/locale.ts`'s `UI_LOCALE`; the TUI passes nothing and needed no
  edits. Optional rather than required because `test/rewindPresentation.test.ts` asserts
  *function identity* (so these modules may only gain a parameter, never be forked) while
  `test/tuiRender.test.ts` asserts English frames — a required parameter would have meant
  touching ~25 terminal call sites for no behavioural gain. Each of the three presentation
  tests pins the default, which is the only thing standing between the terminal and a silent
  language switch. `PERMISSION_OPTIONS` / `ENTER_PLAN_OPTIONS` / `EMPTY_PLAN_OPTIONS` remain
  as the English constants beside their new `…Options(locale)` functions, because they are
  also default parameter values. `riskLevel` and the permission decision source get lookup
  tables too — they are the only wire enums printed to a user unmediated.
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
repo. `shadowRepoPath()` is the one place that knows that layout.

**`deleteSessionArtifacts` (`src/runtime/deleteSession.ts`) is what "delete a session" means** — store
files, shadow repo, session memory, subagent transcripts. `SessionStore.delete` can only ever remove the
first, since the rest belong to modules *above* `sessions/` and calling back down would be a cycle; so
the composition lives in `runtime/`, the layer that already depends on both `harness/` and `services/`.
Spelling the list inline in the caller is exactly how two of the four leaked. **A new
`.myagent/<x>/<sessionId>` artifact is registered there or it is unremovable.** The id is validated by
`assertSafeSessionId` (`sessions/service.ts`, shared with the store's own paths): it rejects `''`, `'.'`,
`'..'` and any separator, because two of the removals are `recursive` and `path.join(dir, '')` is `dir`.
Callers pass the id the store *resolved*, never a prefix. The `'.'` case is not hypothetical — the
validator was first calibrated for the `${id}.json` shape, where `'.'` is harmless, and reusing it for a
whole directory component turned that into an `rm -r` on the shared parent.

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
