# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

Hanekawa (package `myagent`) is a self-hosted terminal coding agent: an Ink/React TUI over a
provider-agnostic agent loop, with session persistence, prompt-cache-aware compaction, permission-gated
tools, subagents, skills, and MCP. `README.md` documents user-facing behavior (config file shape, skills
frontmatter, env vars); this file covers what you need to *change* the code.

## Commands

```bash
npm install                        # or `bun install`; postinstall runs patch-package (required, see Patches)
npm run dev:tui                    # start the TUI (tsx, no build); also: resume <id> | --continue | c | list
npm run typecheck                  # three passes: base + tsconfig.preload.json + tsconfig.renderer.json
npm run build                      # tsc -p tsconfig.build.json → dist/ (only a desktop shell needs this)
npm run build:desktop              # build + esbuild preload/renderer bundles + copy index.html
npm run start:desktop              # electron . (needs a real display)
npm run test                       # full suite: 1818 tests / 39 suites, ~40s
node --import tsx --test test/compact.test.ts                    # single file (space-separate for several)
node --import tsx --test --test-name-pattern "cache break" test/cacheBreakDetection.test.ts
```

Node 22+, no lint step, no build for development. Tests are `node:test` + `node:assert`, flat in `test/`,
with `fast-check` for `*.property.test.ts` and `ink-testing-library` for the few render tests.

**Four tsconfigs, coupled.** `tsconfig.build.json` (only `npm run build`, for the Electron main process,
which cannot use tsx) sets `rootDir: "src"` so `src/x.ts` → `dist/x.js`; without it tsc infers the repo
root — the base `include` spans `src/` and `test/` — emits into `dist/src/**` and changes what every
`import.meta.url`-relative path resolves to (`test/distBuild.test.ts` pins the layout). The base `lib` has
no DOM, so the browser-side files (`src/desktop/renderer/**`, `src/desktop/preload.ts`) must sit in its
`exclude` or the base pass reports ~48 phantom errors; `tsconfig.build.json` excludes them too (esbuild
builds them). `exclude` is inherited, so `tsconfig.preload.json` and `tsconfig.renderer.json` — which add
the DOM libs for exactly those files — **must declare their own**, or both programs come up empty and
report a false green.

## Architecture

### Layering

`prompts/` is a leaf that both `config/` and `harness/` depend on — never import `harness/` from
`prompts/` (cycle). `services/` depends on `tools/`, not the reverse. The harness never sees
`SessionStore`; it talks to the `RecordStream` port (`src/sessions/recordStream.ts`).

```
tui/ (Ink)  →  harness/ (loop, toolRunner, permissions, contextBuilder)  →  config/providers/
                     ↕                          ↓
              sessions/ (JSONL)            prompts/ (budget, composer)      tools/   services/
```

### Runtime tiers — `src/runtime/types.ts`, `sessionScope.ts`, `sessionWorkspace.ts`

Which tier a collaborator sits on is a correctness question, not a taste one:

- **`ProjectRuntime`** — one per `cwd`: `config`, `store`, `ToolRegistry`, MCP connections,
  `BackgroundTaskRegistry`, the reload functions, `shutdown`.
- **`SessionScope`** (`createSessionScope`) — one per conversation: `bridges`, `permissionGate`,
  `promptSections`, and the `createRuntime` closed over all three. Sharing any across sessions is a bug:
  bridges have one handler slot per proxy (session B's prompts land in A's UI); the gate owns the mode,
  session rules and denial counters ("always allow" and plan mode leak between tabs); `promptSections`
  caches `# Environment`, which embeds the model name.
- **`SessionPane`** (`createSessionPane`) — a scope plus the `RuntimeSlot` and `SessionController` driving
  it. The unit a desktop tab owns, and what a one-session shell builds for itself.

`bootstrap()` returns `RuntimeHost = ProjectRuntime & SessionScope` for one-session shells; `SessionHost`
is the one consumer taking the halves separately. `reloadSettings()` fans new rules out to **every** open
scope; `shutdown()` disposes all of them and is the only thing that stops background tasks.

`SessionWorkspace` is the registry over one project:

- **A session belongs to at most one pane** — otherwise two `AgentLoop`s append to one JSONL and two
  `CheckpointService`s snapshot one worktree. `open()` hands back the pane already showing it;
  `switchPane()` refuses before anything is swapped. `paneForSession` *scans* rather than indexing, and
  `SessionPane.getSession()` reads the controller rather than a stored copy — a derived answer cannot go
  stale, whereas a session-id key would need re-keying on every `/clear` and `/resume`. (`scope.session`
  is the session the scope was *built* for and does not move.)
- **`close()` order is fixed:** `interrupt('exit')` → controller → slot → scope. `'exit'` so no
  `turn_interruption` is written for a tab nobody will resume; scope last because draining its bridges
  releases a turn parked on a permission prompt. Idempotent. Closing a pane does **not** stop its
  background tasks — it is `/resume` switching away, not `/clear` (which discards the session).
- `switchPane`/`clearPane` are thin wrappers over `sessionSwitch.ts`, the only copy of that choreography.
  A pane owns **no** `SessionRecordLedger`; the result comes back raw for the caller to rebase its own
  record view.

**N sessions per project is safe; N projects per process is not.** `agentCacheSource(sessionId, cwd)`,
`compact.ts`'s `circuitKey` and the content-hashed `toolSchemaCache` partition correctly, but
`src/commands/registry.ts` is a module-level `Map` and `setCacheBreakDiagnosticsRoot(cwd)` is
process-wide.

### The turn loop — `src/harness/loop.ts`

`AgentLoop.run(userInput, signal?, messageId?, overrides?)` composes four injected collaborators —
`ContextBuilder`, `ToolRunner`, `RecordStream`, `ModelProvider` — and everything crossing those seams is a
`SessionRecord` (the ~15-variant union in `src/harness/types.ts`). Max 100 iterations; the per-iteration
step order is at the top of `run()`.

- **`run()` and `runTool()` both funnel through `enqueue()`**, one in-flight slot guarding `recordsCache`,
  `toolContext` and the record stream. It swallows the prior work's rejection by design.
- **Two abort channels.** `ToolRunner.run` normally *resolves* with a `tool_result` carrying
  `errorCode === 'aborted'` rather than throwing, so any new path awaiting it must inspect `errorCode` and
  convert it to a thrown `AbortError`, or cancellation is silently swallowed.
  `signal.reason === 'user-cancel'` is the user-interrupt sentinel.
- **Any model switch sets `stripAllThinkingBlocksFromRequests` permanently** (thinking signatures are
  provider-bound) and must call `clearCachedSections()` — Environment embeds the model name — plus reset
  cache-break detection and the cache-edit manager. Same after compaction.
- **`applyProgressiveCompaction()` returning true forces a token recount from scratch**; skip it and stale
  estimates leak past a threshold.

### Context assembly — `src/harness/contextBuilder.ts`, `src/harness/sections.ts`

System blocks in order: static literals (cached in `SystemPromptSectionCache`) → project context →
`# Environment` → `# Available skills` → the `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` sentinel (only if dynamic
blocks exist) → custom system → critical reminder → plan/acceptEdits reminder. Everything before the
sentinel is cacheable; `anthropicPayload` joins it into one cached block.

`built.system` is that string *with the sentinel stripped*; the Anthropic path uses `systemBlocks` +
`splitSystemForCaching` instead — not interchangeable. The current date lives in a *user* message, so
midnight doesn't bust the cache. All injected context goes through `wrapInSystemReminder`
(`systemReminder.ts`), the single grep-able wrapper.

### Compaction × prompt caching

`src/prompts/budget.ts` is the single source of truth for token accounting: `effective = contextWindow −
summaryOutputTokens(20k)`, auto-compact at `min(0.93 × effective, effective − 13k)`, micro-compact at
`0.9 × effective`. `countTextTokens` is a deliberately conservative char-class heuristic — swapping in a
real tokenizer shifts every threshold in the system. `DEFAULT_CONTEXT_MANAGEMENT` is duplicated as
literals in `DEFAULT_CONFIG` (`src/config/service.ts`); keep them in sync.

- `compact.ts` never summarizes the most recent user message (`selectRecordsToCompact` stops at
  `lastUserIndex`). Failures are fail-open with a circuit breaker (3 strikes → compaction disabled for the
  session). Session-memory compaction is tried first (no LLM call) and falls through on any throw.
- `selectContextItemsForContext` ends with `repairToolPairing` — dropping orphaned tool_use/tool_result
  pairs is mandatory or the Anthropic API 400s. `src/sessions/invariants.ts` is the on-disk equivalent
  (`/repair`).
- **Ratio-based micro-compaction never mutates local records** — it emits Anthropic `cache_edits` so stale
  tool results are evicted server-side without breaking the cached prefix. `CacheEditManager` exists only
  when `provider.supportsCacheEdits && getPromptCachingEnabled(model)`, so with OpenAI, caching disabled,
  or a per-run model override there is only the time-based stage. `pinEdits()` is wired but never called
  in production.
- **The provider owns cache-break detection** (`cacheBreakDetection.ts`); the loop only emits the metric.
  State is partitioned by `CacheBreakSource` (`agentCacheSource`/`planCacheSource`/`forkCacheSource`, each
  folding in a digest of the project root) — reusing one across unrelated request streams poisons the
  baseline. Use `displayCacheSource()` for anything user-visible; the source is hashed into
  `prompt_cache_key` on the OpenAI path.

### Tools — `src/tools/`

The `Tool` interface lives in `src/harness/types.ts`, not in `src/tools/`. `riskLevel`
(`safe|confirm|dangerous`) is consumed only by the permission gate; `isReadOnly`/`isDestructive` drive
concurrency batching and subagent tool filtering.

`src/tools/index.ts` is a **hand-maintained array** — no auto-discovery. Add `src/tools/<name>.ts`
exporting `xxxTool: Tool` (or `createXxxTool(deps)`), then register it in `getBuiltinTools()`; that array
also feeds `src/tools/display.ts`, so a tool missing from it silently loses every TUI display hook. Set
`searchHint` (3–10 words, for ToolSearch) and `maxResultSizeChars` for large output; `shouldDefer: true`
hides a tool behind ToolSearch, `alwaysLoad: true` opts out. Tools with a subdirectory (`ToolSearchTool/`,
`Task*Tool/`) split into `constants.ts` / `prompt.ts` / `<Name>Tool.ts` so prompt-assembly code can import
the name constant without the implementation. `TASK_*_TOOL_NAME` and `isDeferredTool` each exist in two
places — keep in sync.

**Concurrency batching lives in the loop, not the runner:** `runToolCallsInOrder` greedily groups
*contiguous* concurrency-safe calls (`Promise.allSettled`) and runs everything else serially. Safe means
not `isDestructive` and (`isConcurrencySafeInput(input)` or both `isConcurrencySafe` and `isReadOnly`).
`ToolRunner.run` always emits a `tool_approval` record (approved or not) and always emits a `tool_result`
+ runs `postToolUse` on every early-return path (invalid input, denial, abort, hook block).

**Subagents** (`src/tools/agentTool.ts`) build a complete nested harness per run — own `PermissionGate`,
`ToolRunner`, `ContextBuilder`, `AgentLoop`, and a `MemoryRecordStream` (foreground) or
`SidechainRecordStream` (background). The `Agent` tool is per-runtime and deliberately *not* in
`getBuiltinTools()`; `tui.tsx` appends it last. Built-ins `general`/`fork`/`explore`/`plan` are
overridable by Markdown files in `.myagent/agents/`.

### Permissions — `src/harness/permissions.ts`

`PermissionMode = 'default' | 'plan' | 'acceptEdits' | 'bypass' | 'readonly'`. Even in `bypass`, deny
rules, ask rules, `checkWindowsPathSafety` findings, and `PROTECTED_PATHS` (`.git`, `.vscode`, `.idea`,
`.myagent` — `src/utils/permissions/protectedPaths.ts`) still prompt; shell-syntax findings and
destructive commands are *not* bypass-immune.

**Rule matching is asymmetric:** for Bash, `deny`/`ask` rules strip env-var prefixes and match the whole
command *and every segment*; `allow` rules match the whole command only. "Always allow" refuses compound
commands unless every segment yields an identical prefix (`shellRuleMatching.ts`), and its side effect
must fire *before* the prompt resolves — `PermissionGate` reads the captured flag on the line after
`await this.prompt(...)`. Anti-loop machinery (per-tool denial streaks, global auto-deny counter)
escalates silent auto-denials back into real prompts. Always change modes through
`applyPermissionModeTransition` (`src/runtime/permissionMode.ts`), which couples `PermissionGate` ↔
`PlanModeManager`.

**`ToolRunner.run` does not pass its abort signal into `PermissionGate.approve`**, so cancelling a turn
never unblocks a pending prompt. Three rules below — bridge draining, pane close order, renderer Escape
ordering — exist only because of this.

### Providers — `src/config/`

Three-layer model abstraction: `endpoints` (provider + baseUrl + apiKey) ← `models` (model id + endpoint
ref) ← `profiles` (`fast|balanced|powerful`). `Routing` maps roles (`main`, `plan`, `compact`,
`subagent[type]`) to a tier or `inherit`.

Settings precedence: `~/.myagent/settings.json` → `<cwd>/.myagent/settings.json` → legacy `mcp.json` →
`settings.local.json` (permissions and hooks arrays **concatenate**; scalars last-wins); then
`config.json` wins over settings, `~/.myagent/config.json` (shared) → `<cwd>/.myagent/config.json`.
`ConfigService.save()` targets the project file only when it already exists, otherwise the global one, so
launching in an arbitrary directory doesn't scatter API keys; pass `{ globalConfigPath: null }` to drop
the shared layer. Validation is hand-rolled, not zod.

Add a provider by extending `PROVIDER_FACTORIES` in `providers/registry.ts`. **`nativeAnthropic` is
decided purely by `baseUrl.includes('anthropic.com')`** (undefined = native) and gates cache_control,
cache_edits, `context_management`, betas, and `defer_loading` — proxy endpoints fall back to inline tool
schemas. **Model fallback is a retry-layer signal, not a config decision:** exhausting the overload budget
throws `FallbackTriggeredError` from `retry.ts`, which the loop catches to call `activateFallback()`.

The two payload builders diverge a lot — `anthropicPayload.ts` folds records into content blocks and
injects cache markers (pruned to the limit of 4 by `finalizeAnthropicCacheControl`); `openaiPayload.ts`
emits flat role messages and a hashed `prompt_cache_key`. Both route zod → JSON Schema through
`harness/toolApiSchema.ts`, whose session-scoped cache keeps schema churn from busting the prompt cache.

### TUI — `src/tui/`

`entrypoints/tui.tsx` is the only wiring point, and startup order matters: focus-filter install must
precede Ink attaching stdin, and MCP trust prompts must happen before Ink owns stdin. It gets its
`RuntimeSlot` + `SessionController` pair from `createSessionPane(host, host)` and hands them to `App` —
those two carry all the framework-agnostic session state, so a different shell replaces only the view
layer. `App.tsx` is the single stateful shell; `hooks/useAgentLoop.ts` renders the controller's event
stream into Ink; `hooks/useKeyboardShortcuts.ts` is the one global key handler (App holds no input state).

- **`createRuntime` is a factory closed over everything.** Model switches, `/clear` and resume replace the
  runtime — always via `RuntimeSlot.replace` (`src/runtime/runtimeSlot.ts`), which installs the new
  runtime *before* disposing the old one so a late dispose can't tear down its successor. The slot also
  owns the effort level, since clamping depends on the active model's `maxEffort`. **Runtime tool arrays
  are mutated in place** (`splice`) so MCP reconnects propagate into live subagent closures; never swap a
  tools array by identity.
- **`SessionController` (`src/runtime/sessionController.ts`) owns the turn lifecycle**: abort,
  checkpointing, token totals, tool-progress correlation, interrupt rollback. It exclusively owns the
  three `RecordProxy` handlers (a UI subscribes via `onEvent`, never `setHandler`, or records get handled
  twice) and republishes everything as one ordered `SessionEvent` stream plus a `useSyncExternalStore`
  snapshot. `turn-end` carries `aborted` (the signal) rather than "did it throw" — a *failed* turn is not
  aborted and still gets its duration summary. Only `transcript-reset` events with `bumpGeneration`
  remount Ink's `<Static>`; a rollback must not.
- **Switching sessions is not just `controller.retarget`.** `runtime/sessionSwitch.ts` also rebuilds the
  runtime (`createRuntime` + `RuntimeSlot.replace`, replace *last*), restores background tasks and
  reconciles orphaned agents; skip the rebuild and the `AgentLoop` stays bound to the session it left.
  Both `SessionHost` and `App.tsx` go through it, and it returns raw `SessionDiagnostic`s rather than
  formatted notices. Its optional `beforeApply` hook is where the shell's `MessageQueue` gets rebound and
  must run *before* `RuntimeSlot.replace` — past that point the slot has notified `useSyncExternalStore`
  and a queue still keyed to the old session could pump into the new one. A caller cannot do it earlier,
  since a new session's id doesn't exist until `createDraft()`.
- **Only the permission bridge parks.** `createPromptProxy` queues requests until a UI attaches rather
  than auto-denying; the other three answer immediately, because headless callers depend on it. The five
  fallbacks are deliberately asymmetric — permission/AskUserQuestion/exit-plan reject, **enter-plan
  approves**, record drops — and must not be unified. Every UI teardown path has to settle its in-flight
  requests.
- **`transcript.ts` encodes the load-bearing TUI invariant:** Ink `<Static>` output cannot be retracted
  once a later sibling is emitted. Items live in `staticItems` / `liveItems` / `liveSystemItems` and are
  promoted in a strict order; plain assistant messages go straight to static, so preceding live user
  messages must be committed first. Hidden tools (ToolSearch, plan tools, Task*, Skill, AskUserQuestion)
  render nothing but still mark group boundaries to preserve chronology.
- **`layout.ts` hand-duplicates the row arithmetic of the render components** — changing a component's
  height without updating `estimate*Rows` causes flicker/overdraw (`test/tuiLayout.test.ts`).
- Import **`../ink.js`, not `ink`**, anywhere cursor or frame state matters: `src/tui/ink.tsx` is a façade
  over Ink internals providing `useDeclaredCursor` and alt-screen frame snapshot/restore.
- Colors come only from the frozen `theme` object in `src/tui/theme.ts` — add a semantic key rather than a
  literal (`test/tuiTheme.test.ts` also makes *source-level* assertions about `Markdown.tsx` and
  `UserMessage.tsx`). Animation ticks off one shared clock (`clock/ClockContext.tsx`, 16ms) that pauses on
  focus loss or overlay; don't add `setInterval` in components.
- The message queue is a **`MessageQueue` instance** owned by `App` (one per session, persisted as
  `message_queue` records); Enter always enqueues and a guarded effect pumps it. `subscribe`/`getSnapshot`
  are bound methods so `useSyncExternalStore` sees stable identities. The pump's guard is `canPumpQueue`
  (`src/runtime/queuePump.ts`), which separates "a turn is running" from "the UI is blocked" so a
  non-terminal shell can define the latter differently.
- Slash commands (`src/commands/`) are a module-level `Map` of plain `{name, description, run}` objects
  that render nothing — all effects go through optional `CommandContext` callbacks, so every command must
  tolerate `undefined` ones. Skill commands are prompt macros with per-invocation model/effort/tool
  overrides; built-ins always shadow same-named skills.

### The process boundary — `src/runtime/protocol/`

Imports no Electron. `SessionHost` owns the runtime and speaks `HostEvent`/`HostCommand` over a
`RuntimeChannel`, taking `project` and `scope` as separate deps (the one consumer that ever gets a second
scope). `SessionClient` mirrors `SessionController`'s shape for a renderer.

- **Three wire types replace originals that cannot be cloned:** `WireRunOverrides` (a model *key*, never a
  live provider; no `hooks`), `WireRuntimeSnapshot` (`apiKey` stripped) and `PermissionRequestDto`
  (`toolName` + `riskLevel` instead of the `Tool`; `onAlwaysAllow` becomes a response flag the host fires
  *before* resolving). Anything added must survive `structuredClone` — `createMemoryChannelPair` clones on
  every post so violations fail loudly, since `child_process.send` defaults to JSON and *silently drops*
  functions.
- **`SessionClient` must field-diff before swapping its snapshot *and* its background-task list**, because
  `SessionController.publish` compares `usage` and `taskSnapshot` by reference while every deserialized
  message is a fresh object graph.
- **Everything inbound is validated; nothing outbound is.** `parseHostCommand`
  (`protocol/commandSchema.ts`) runs a `.strict()` discriminated union over all 31 `HostCommand` variants
  before `handleMessage` dispatches — the client half is the less trusted end, and `set-permission-mode`
  reaches `PermissionGate` directly. The schema is a second description of the union, kept honest by two
  compile-time guards: a keyed `satisfies Record<HostCommand['type'], …>` table that fails *by name*, and
  a mutual-assignability assertion for field-level drift. A malformed message with a recoverable `id` gets
  a `fail`; a malformed `ui-response` is settled with that kind's own fallback rather than dropped, since
  nothing else releases a pending prompt. `SessionClient` deliberately does not mirror any of this.
  Two traps: `PERMISSION_MODES` is the Shift+Tab *cycle order* (4 values, deliberately no `'readonly'`),
  not the mode set; and `set-effort.level` is `z.string()` because numeric effort is a raw token budget
  arriving as a decimal string — only `WireRunOverrides.effort` is the enum.
- **`execute()`'s exhaustiveness is enforced by `assertNever`, not by the absent `default`.** With
  `Promise<unknown>` and `noImplicitReturns` off, an unhandled variant compiles clean and answers
  `{ type: 'reply', result: undefined }` — a no-op reported as success. Don't turn `assertNever(command)`
  into a `default` branch, and don't delete it.
- **DTOs carry derived data so a renderer never imports `harness/`.** `PermissionRequestDto` ships a
  `preview` (bounded by `capFileToolPreview`) and precomputed `destructiveWarnings`; `toPermissionDto`
  (`protocol/permissionDto.ts`) takes `cwd` explicitly and is shared by `SessionHost` and the TUI's
  `usePermission`, so both dialogs render from identical input. `WireModelsResult.pickerOptions` is the
  same bargain (`buildModelPickerOptions` needs `ConfigService.getModel`). **Anything projected from
  `ModelConfig` is built field by field, never spread** — `resolveModel` folds the endpoint's `apiKey` and
  `baseUrl` into what it returns, so one spread in `WireModelInfo` ships every configured key to the
  renderer.
- **`client.ts` must not *value*-import `harness/`, `services/`, `sessions/` or `commands/`** — the last
  would drag the slash-command registry, and through `skills.ts` the filesystem, into a renderer bundle
  (`test/protocolClientParity.test.ts` pins all four). `protocol/index.js` transitively pulls `node:fs`,
  so a renderer deep-imports `protocol/client.js`, not the barrel.
- **Slash commands run host-side; `CommandEffect` is the part that cannot.** `createHostCommandContext`
  (`protocol/commandContext.ts`) satisfies 24 of `CommandContext`'s 31 members from the host's own
  collaborators; the other 7 mean nothing outside a view, so they leave as `write-line` /
  `open-command-view` / `open-surface` effects on `HostEvent`. That is why `run-command` takes the raw
  line and is not plain request/response — a command pushes effects *while running* and they must arrive
  before its `reply`; do not turn them into reply fields. `COMMAND_CONTEXT_COVERAGE` is a keyed
  `satisfies` table like `COMMAND_SCHEMAS`, so a new `CommandContext` member fails the build *by name*
  until someone decides which side runs it. The context is rebuilt per command and reads the session and
  records through getters, since `/model` and `/clear` replace both mid-command. An unknown command and
  one that threw are both `handled` with a `write-line`; only non-slash input is unhandled, and `/exit`
  returns a flag rather than shutting the host down. `list-commands` is the companion read — a renderer
  builds its completion dropdown without importing `commands/` — and `WireCommandInfo` is built field by
  field because `CommandDefinition` carries `run` and Electron's IPC drops functions *silently*.
- **Both `/rewind` writes end with the same three steps:** `invalidateRecordsCache()` →
  `controller.reload()` → `ledger.rebase()`. Drop the first and the loop keeps serving records it already
  read; drop the last and the discarded records fold back into whatever `set-model` or `reload-settings`
  builds next. `truncate-session` throws on a message it cannot find rather than reporting it.
  `restore-code-and-conversation` has no command of its own — it is `restore-code` then
  `truncate-session`, composed by the caller.
- **The pane commands are the only place a host reaches past its own session.** `open-pane` /
  `close-pane` / `list-panes` work off `PaneRegistry`, the `SessionWorkspace` slice `SessionHost` declares
  *structurally* so the protocol layer never has to know the registry is a class. The split is the same as
  everywhere else: the host resolves and registers the pane — one pane per session, so `open-pane` on an
  already-open session hands back the existing one rather than a second `AgentLoop` on one JSONL — and
  then `onPaneOpened` / `onPaneClosed` hand off to the shell, because a host has no handle on a
  `BrowserWindow`. Both fire for *resolved* panes, including one that was already open, so the shell's
  callback has to be idempotent (focus it, don't build a second window).
- **`paneId` is the pane's *current* session id, and that is not a stable key.** `collectPanes()` reads it
  through `SessionPane.getSession()`, which derives from the controller — so `/clear` and `/resume` move
  it, exactly as `SessionWorkspace` refuses to index on it for. Nothing re-announces the list on a session
  change: `broadcastPaneList()` fires only from `open-pane` / `close-pane`, and it posts to *this* host's
  channel alone. So a shell must (a) re-key or re-derive its own pane bookkeeping when `session-changed`
  arrives, and (b) fan `pane-list` out to the other panes itself by iterating its `SessionHost`s. `main.ts`
  does neither today — see `todo.md`.

### Electron shell — `src/desktop/`

The second consumer of the runtime, one `BrowserWindow` per pane: `main.ts` is `bootstrap()` →
`new SessionWorkspace(host)` → per window a `SessionPane`, a channel and a `SessionHost`, which is the
same assembly `tui.tsx` does exactly once. `preload.ts` exposes only `{send, onMessage, close}` on
`window.hanekawa`; `renderer/app.ts` imports no Node module and draws the four blocking requests,
streaming output, slash commands, the tab bar and four of the five `CommandSurface` pickers
(`provider-panel` is the one it ignores by name — that is why the five collapse into a single wire
variant).

**A tab is a window here, not a pane inside one.** Every window renders the *whole* workspace in its tab
bar and "switching" is `open-pane({sessionId})` resolving to a pane that already exists, which the shell
turns into a focus call. That is why no multiplexing is needed: `createElectronMainChannel(ipc, target)`
takes the target as a parameter, so N channels share one `ipcMain` and each claims its own traffic by
`event.sender` (`test/electronChannel.test.ts` pins the isolation). Only a single-pipe transport like
`nodeChannel.ts` would need lanes.

The transport interfaces (`ipc/electronChannel.ts`) are **structural, not `import`ed from `electron`**, so
the file is loadable from a plain-node test. Each rule below was a launch-blocking bug `tsc` could not
see, hidden behind an `as unknown as`:

- **Assign, don't cast.** `const mainIpc: MainSideIpc = ipcMain` and
  `const ipc: RendererSideIpc = ipcRenderer` are plain annotations, and the real `WebContents` is passed
  uncast — that assignment *is* the check. `test/electronChannel.test.ts` adds `Satisfied<Real, Ours>`
  compile-time assertions over type-only `electron` imports as a second net.
- **`webContents` is an `EventEmitter` (`.on`/`.removeListener`); the DOM `window` is an `EventTarget`
  (`.addEventListener`).** `WebContents` has no `addEventListener` at all.
- **`ipcMain.on`/`ipcRenderer.on` return `this`, not an unsubscriber.** Teardown goes through
  `removeListener` on every close path, not just an explicit `close()`, or a crashed renderer leaves a
  listener on the process-wide `ipcMain` — one per pane.
- **The channel and `SessionHost` are wired before `loadFile`, with no ready handshake.** `ipcMain.on` is
  registered before the renderer process exists, so no inbound command can be dropped, and `SessionHost`
  is reply-driven because all four subscriptions its constructor makes register a listener *without
  invoking it*. **If any of those ever fires on registration, revisit this ordering.** `nodeChannel.ts`
  does need a `__ready` handshake, because a forked child may not have its listener up.
- **Paths in `dist/desktop/` anchor to the module's own directory**
  (`dirname(fileURLToPath(import.meta.url))`), never by counting `..` up to the repo root — the emitted
  depth differs from the source depth.
- **`before-quit` must `preventDefault()` and await teardown** (`sessionHost.dispose()` → `pane.close()` →
  `await host.shutdown()`), then re-`quit()` behind a flag; Electron will not wait for background-task
  shutdown on its own. With N panes that is a loop over all of them before the single `host.shutdown()`,
  since `ProjectRuntime` is shared and stopping it is what stops background tasks.
- **Nothing in `main.ts` is covered by a test.** It calls `app.requestSingleInstanceLock()` at module top
  level, so under plain node — where `require('electron')` yields a path string — importing it throws
  before any test runs; `test/desktopMain.test.ts` drives channel + host + client directly with a fake
  `PaneRegistry` instead. Everything that lives *only* in `main.ts` (window↔pane bookkeeping, which pane
  gets the first window, teardown ordering) is therefore verified by reading and by real-machine smoke,
  not by the suite. Prefer pushing a decision into `SessionHost` or a `model/` module over adding one
  here.
- **One implementation per side.** The renderer's channel lives in `renderer/bridgeChannel.ts` and is what
  both `app.ts` and the tests use — it used to be inlined in `app.ts` while the suite tested a separate
  factory nothing shipped, which is how the two API lies above survived a green build.

**The renderer is a `model/` + `dom/` split, and that is a correctness constraint, not tidiness.**
`renderer/model/*` holds every decision (which options a dialog offers, how a keystroke maps to an answer,
how a `stream` event folds into the transcript) as pure functions; `renderer/dom/*` and `app.ts` only turn
those into nodes and listeners. There is no DOM in the test runner and no jsdom, so a decision is only
testable if it is DOM-free — and **a `model/` module imported by a `test/` file is compiled in the *base*
program, which has no DOM lib** (`exclude` filters globs, it does not stop import-following; `tsc --noEmit
--listFiles` shows `renderer/bridgeChannel.ts` in that program today). So these modules take structural
key shapes (`{ key, shiftKey }`), never `KeyboardEvent`/`HTMLElement`, exactly as `bridgeChannel.ts:26-29`
does.

**Neither typecheck pass can see a Node-only global in renderer code.** `tsc -p tsconfig.renderer.json
--listFiles` pulls ~130 host files in through the wire types, including `src/utils/paths.ts`, which
imports `node:fs` — so `@types/node`'s globals are in scope despite `"types": []`, and a renderer file
using `process.env` compiles clean in **both** passes and then `ReferenceError`s in Chromium (verified by
mutation). `tsconfig.renderer.json`'s `include` list documents the allowed shared surface;
`test/rendererImports.test.ts` is what actually enforces it — no value import of
`harness/|services/|sessions/|commands/|tui/`, an allowlist for shared modules, and no Node global.
`node:crypto` is the one permitted Node import, and only because `build:desktop` aliases it to
`renderer/runtime/nodeCryptoShim.ts`.

- **Escape must answer an open dialog before it interrupts** (`renderer/model/keymap.ts`); a turn parked
  on a permission prompt is not released by interrupting, so the two branches in the wrong order wedge the
  window.
- **Tab-bar chords are resolved *before* the keymap, and that is only safe because they are all
  modifier-gated.** `tabBarKeyToIntent` (`renderer/model/tabBar.ts`) returns `'none'` unless
  `ctrlKey`/`metaKey` is set, so Ctrl+T / Ctrl+W / Ctrl+1–9 win over an open dialog the way a browser's do
  while bare Escape still reaches the rule above. Give it an unmodified key and it silently takes
  precedence over every dialog.
- **A blocking request must always be answered.** `SessionClient.answer` wraps the handler in try/catch
  and falls back to `UI_REQUEST_FALLBACKS[kind]()` (same asymmetry as the bridges); without it a throwing
  dialog posts no `ui-response` and the agent loop waits for the life of the process. The renderer's own
  handlers are the second net.
- The composer gates Enter *and* the button on `isStreaming`: `requestSubmit()` ignores a disabled button,
  and `SessionController.submit` has no in-flight guard, so a second turn overwrites the live
  `AbortController` and the first becomes impossible to interrupt. With a completion dropdown open, Enter
  is "accept **and** run" and Tab is accept-only, matching `useKeyboardShortcuts.ts:286-291`.
- Shared presentation lives in `runtime/permissionPresentation.ts` and `runtime/planPresentation.ts`,
  which both shells import so they cannot offer different options. Both are pure with type-only
  cross-layer imports — a single value import there breaks the renderer bundle.
- **No `innerHTML` anywhere in the renderer.** Transcript text, tool output and diffs are model- or
  filesystem-authored, and `script-src 'self'` does nothing about an `onerror=` attribute.

### Sessions & state — `src/sessions/`, `.myagent/`

Everything persistent lives under `<cwd>/.myagent/` (gitignored) via `src/utils/paths.ts`. The two
user-level exceptions are `~/.myagent/settings.json` and `~/.myagent/config.json`
(`getGlobalConfigPath()`), which every project reads as a base layer — sessions, skills and plans stay
strictly per-project.

`SessionStore` writes `<id>.jsonl` append-only; full rewrites go through `writeFileAtomic` (tmp + rename).
**New sessions are in-memory drafts** — nothing touches disk until the first `message` record.
`messageCount`/`title`/`updatedAt` are always *derived*; `compactFailureCount`/`denialState` must be
explicitly preserved on rewrites (easy to drop when adding a path). Class-level lock maps serialize
mutations within a process, and `src/sessions/fileLock.ts` nests an `O_EXCL` advisory lock inside them for
cross-process safety, stealing a lock only when it is both stale and owned by a dead pid, and proceeding
without it on timeout rather than wedging a write forever. Reads self-heal (index rebuild, legacy
migration, malformed-line skipping) and report `SessionDiagnostic[]` rather than throwing.

`services/checkpoint/` snapshots the working tree before every turn into a **separate shadow git repo** at
`.myagent/shadow-git/<sessionId>` with `core.worktree` pointed at the project root, so `/rewind` never
touches the user's real repo.

## Conventions

- **`import { z } from 'zod/v3'`** — never bare `zod`. Schemas are `.strict()`.
- **Every relative import carries a `.js` extension** (NodeNext ESM, zero exceptions in `src/`).
- Prefer extracting pure functions and testing those over rendering components — that is why `layout.ts`,
  `transcript.ts`, `budget.ts`, `cli.ts` and the suggestion modules are pure.
- Module-level env caches exist (e.g. `resetToolSearchCache`, `clearProjectContextCache`) — reset them in
  tests.
- Commit messages follow no consistent convention; match the surrounding history or keep it short.
- `AGENTS.md` is a byte-for-byte mirror of this file apart from its title and the "guidance to …" line;
  edit both together. `todo.md` carries desktop-port progress and the open work.

## Patches

`patches/` is applied by `postinstall` (patch-package); `ink` is pinned to `7.0.6`. `ink+7.0.6.patch` adds
CJK/full-width line breaking with kinsoku rules (via injected U+200B), a cursor suffix fix, Windows
Terminal resize reflow handling (`WT_SESSION`) and a reconciler use-after-free fix.
**`wrap-ansi+10.0.0.patch` is its required counterpart** — it teaches `wrap-ansi` to split on U+200B, and
changing one without the other breaks wrapping. `test/tuiInkPatch.test.ts` imports
`node_modules/ink/build/*` directly and fails if the patches aren't applied.
