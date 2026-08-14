# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Hanekawa (package name `myagent`) is a self-hosted terminal coding agent: an Ink/React TUI over a
provider-agnostic agent loop, with session persistence, prompt-cache-aware compaction,
permission-gated tools, subagents, skills, and MCP. `README.md` documents user-facing behavior
(config file shape, skills frontmatter, env vars); this file covers what you need to *change* the code.

## Commands

```bash
npm install                        # or `bun install`; postinstall runs patch-package (required, see Patches)
npm run dev:tui                    # start the TUI (tsx, no build step); also: resume <id> | --continue | c | list
npm run typecheck                  # tsc --noEmit
npm run test                       # full suite: 1415 tests / 35 suites, ~38s
node --import tsx --test test/compact.test.ts                    # single file
node --import tsx --test test/a.test.ts test/b.test.ts           # several files
node --import tsx --test --test-name-pattern "cache break" test/cacheBreakDetection.test.ts
```

There is no lint step and no build for development (`tsc` emits to `dist/` only if invoked directly).
Requires Node 22+. Tests are `node:test` + `node:assert`, flat in `test/` (no helpers dir), with
`fast-check` for `*.property.test.ts` and `ink-testing-library` for the few render tests.

## Architecture

### Layering

`prompts/` is a leaf that both `config/` and `harness/` depend on — never import `harness/` from
`prompts/` (cycle). `services/` depends on `tools/` (e.g. `agentDefinitionLoader` imports constants
from `agentTool.ts`), not the reverse. The harness never sees `SessionStore`; it talks to the
`RecordStream` port, adapted by `src/sessions/recordStream.ts`.

```
tui/ (Ink)  →  harness/ (loop, toolRunner, permissions, contextBuilder)  →  config/providers/
                     ↕                          ↓
              sessions/ (JSONL)            prompts/ (budget, composer)      tools/   services/
```

### The turn loop — `src/harness/loop.ts`

`AgentLoop.run(userInput, signal?, messageId?, overrides?)` composes four injected collaborators:
`ContextBuilder`, `ToolRunner`, `RecordStream`, `ModelProvider`. Everything crossing those seams is a
`SessionRecord` (the union in `src/harness/types.ts`, ~15 variants: `message`, `tool_use`,
`tool_result`, `tool_approval`, `compact_boundary`, `subagent_task`, `turn_interruption`,
`message_queue`, …).

Per iteration (max 100): drain parent messages → `planModeManager.beforeTurn()` → sync role model →
load + `prepareRecordsForRequest` → progressive compaction → auto-compact → `contextBuilder.build()` →
ToolSearch filtering → `provider.createMessage()` → append assistant record → tools or `finishTurn()`.

Invariants that bite:
- **`run()` and `runTool()` both funnel through `enqueue()`**, a single in-flight slot guarding
  `recordsCache`, `toolContext`, and the record stream. `enqueue` intentionally swallows the prior
  work's rejection (sequencing only).
- **Two abort channels.** `ToolRunner.run` normally *resolves* with a `tool_result` carrying
  `errorCode === 'aborted'` rather than throwing. Any new path that awaits `toolRunner.run` must
  inspect `errorCode` and convert it to a thrown `AbortError`, or cancellation is silently swallowed.
  `signal.reason === 'user-cancel'` is the user-interrupt sentinel.
- **Any model switch sets `stripAllThinkingBlocksFromRequests` permanently** (thinking signatures are
  provider-bound) and must clear cached prompt sections + reset cache-break detection and the cache-edit
  manager. The cached Environment section embeds the model name — that is why `clearCachedSections()`
  is called on every switch and after compaction.

### Context assembly — `src/harness/contextBuilder.ts`, `src/harness/sections.ts`

System blocks in order: static literals (`intro`, `system`, `doing-tasks`, `actions`, `using-tools`,
`tone-and-style`, `output-efficiency`, cached in `SystemPromptSectionCache`) → project context →
`# Environment` → `# Available skills` → the `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` sentinel (only if dynamic
blocks exist) → custom system → critical reminder → plan/acceptEdits reminder. Everything before the
sentinel is cacheable; `anthropicPayload` joins it into one cached block.

`built.system` is the joined string *with the sentinel stripped*; the Anthropic path uses `systemBlocks`
+ `splitSystemForCaching` instead — the two are not interchangeable. The current date lives in a *user*
message, not the system prompt, so midnight doesn't bust the cache. All injected context goes through
`wrapInSystemReminder` (`systemReminder.ts`) — the single grep-able wrapper.

### Compaction × prompt caching

`src/prompts/budget.ts` is the single source of truth for token accounting: `effective = contextWindow −
summaryOutputTokens(20k)`, auto-compact at `min(0.93 × effective, effective − 13k)`, micro-compact at
`0.9 × effective`. `countTextTokens` is a deliberately conservative char-class heuristic — swapping in a
real tokenizer shifts every threshold in the system. `DEFAULT_CONTEXT_MANAGEMENT` is duplicated as
literals in `DEFAULT_CONFIG` (`src/config/service.ts`); keep them in sync.

- `compact.ts` never summarizes the most recent user message (`selectRecordsToCompact` stops at
  `lastUserIndex`). Failures are fail-open with a circuit breaker (3 strikes → compaction disabled for
  the session) and write `compact_attempt_failed` records. Session-memory compaction is tried first
  (no LLM call) and falls through on any throw.
- `selectContextItemsForContext` ends with `repairToolPairing` — dropping orphaned tool_use/tool_result
  pairs is mandatory or the Anthropic API 400s. `src/sessions/invariants.ts` does the on-disk
  equivalent (`/repair`), inserting synthetic records for lost pairs.
- **Ratio-based micro-compaction never mutates local records** — it emits Anthropic `cache_edits` so
  stale tool results are evicted server-side without breaking the cached prefix. `CacheEditManager` is
  constructed only when `provider.supportsCacheEdits && getPromptCachingEnabled(model)`, so with
  OpenAI, caching disabled, or a per-run model override there is *no* ratio-based micro-compact — only
  the time-based stage. `pinEdits()` is wired end-to-end but production never calls it.
- `applyProgressiveCompaction()` returning true forces the loop to recount tokens from scratch; skip
  that and stale estimates leak past a threshold.
- **The provider owns cache-break detection** (`cacheBreakDetection.ts`); the loop only emits the
  metric. State is partitioned by `CacheBreakSource` — reusing one source across unrelated request
  streams poisons the baseline (`agentCacheSource` / `planCacheSource` / `forkCacheSource`).

### Tools — `src/tools/`

The `Tool` interface lives in `src/harness/types.ts`, not in `src/tools/`. Required: `name`,
`description`, `inputSchema` (zod), `riskLevel`, `execute(input, context)`. `riskLevel`
(`safe|confirm|dangerous`) is consumed only by the permission gate; `isReadOnly`/`isDestructive` drive
concurrency batching and subagent tool filtering.

`src/tools/index.ts` is a **hand-maintained array** — no auto-discovery. To add a tool: create
`src/tools/<name>.ts` exporting `xxxTool: Tool` (or `createXxxTool(deps)` if it needs runtime deps),
then register it in `getBuiltinTools()`. That array also feeds `src/tools/display.ts`, so a tool missing
from it silently loses every TUI display hook. Set `searchHint` (3–10 words, used by ToolSearch) and
`maxResultSizeChars` for large output; `shouldDefer: true` hides it behind ToolSearch, `alwaysLoad: true`
opts out.

Tools with a subdirectory (`ToolSearchTool/`, `Task*Tool/`) split into `constants.ts` / `prompt.ts` /
`<Name>Tool.ts` so prompt-assembly code can import the name constant without pulling in the
implementation. Note `TASK_*_TOOL_NAME` and `isDeferredTool` each exist in two places — keep in sync.

**Concurrency batching lives in the loop, not the runner:** `runToolCallsInOrder` greedily groups
*contiguous* concurrency-safe calls (`Promise.allSettled`) and runs everything else serially. A tool is
safe only if not `isDestructive` and (`isConcurrencySafeInput(input)` or both `isConcurrencySafe` and
`isReadOnly`). `ToolRunner.run` always emits a `tool_approval` record (approved or not) and always
emits a `tool_result` + runs `postToolUse` on every early-return path (invalid input, denial, abort,
hook block).

**Subagents** (`src/tools/agentTool.ts`, 1.5k lines) build a complete nested harness per run — own
`PermissionGate`, `ToolRunner`, `ContextBuilder`, `AgentLoop`, and a `MemoryRecordStream` (foreground)
or `SidechainRecordStream` (background). The `Agent` tool is per-runtime and deliberately *not* in
`getBuiltinTools()`; `tui.tsx` appends it last. Built-in definitions: `general`, `fork`, `explore`,
`plan`, overridable by Markdown files in `.myagent/agents/`.

### Permissions — `src/harness/permissions.ts`

`PermissionMode = 'default' | 'plan' | 'acceptEdits' | 'bypass' | 'readonly'`. Even in `bypass`, deny
rules, ask rules, `checkWindowsPathSafety` findings, and `PROTECTED_PATHS`
(`.git`, `.vscode`, `.idea`, `.myagent` — `src/utils/permissions/protectedPaths.ts`) still prompt.
Shell-syntax findings and destructive commands are *not* bypass-immune.

**Rule matching is asymmetric:** for Bash, `deny`/`ask` rules strip env-var prefixes and match the whole
command *and every segment*; `allow` rules match the whole command only. "Always allow" refuses compound
commands unless every segment yields an identical prefix (`shellRuleMatching.ts`). Anti-loop machinery
(per-tool denial streaks, global auto-deny counter) escalates silent auto-denials back into real prompts.
Always change modes through `applyPermissionModeTransition` (`src/runtime/permissionMode.ts`), which couples
`PermissionGate` ↔ `PlanModeManager`.

### Providers — `src/config/`

Three-layer model abstraction: `endpoints` (provider + baseUrl + apiKey) ← `models` (model id +
endpoint ref) ← `profiles` (`fast|balanced|powerful`). `Routing` maps roles (`main`, `plan`, `compact`,
`subagent[type]`) to a tier or `inherit`. Settings load with precedence
`~/.myagent/settings.json` → `<cwd>/.myagent/settings.json` → legacy `mcp.json` →
`settings.local.json` (permissions and hooks arrays **concatenate**; scalars last-wins), then the
`config.json` layers win over settings: `~/.myagent/config.json` (shared across projects) →
`<cwd>/.myagent/config.json`. `ConfigService.save()` targets the project file only when it already
exists, otherwise the global one — so launching in an arbitrary directory doesn't scatter API keys.
Pass `{ globalConfigPath: null }` to drop the shared layer (tests do this via a temp `USERPROFILE`).
Validation is hand-rolled, not zod.

`ModelProvider` is just `{ name, createMessage, supportsDynamicToolSearch?, supportsCacheEdits? }`. Add
a provider by extending `PROVIDER_FACTORIES` in `providers/registry.ts`. **`nativeAnthropic` is decided
purely by `baseUrl.includes('anthropic.com')`** (undefined = native) and gates cache_control,
cache_edits, `context_management`, betas, and `defer_loading` — proxy endpoints fall back to inline tool
schemas. **Model fallback is a retry-layer signal, not a config decision:** exhausting the overload
budget throws `FallbackTriggeredError` from `retry.ts`, which the loop catches to call
`activateFallback()`.

The two payload builders diverge a lot: `anthropicPayload.ts` folds records into content blocks, injects
cache markers (pruned to the limit of 4 by `finalizeAnthropicCacheControl`), and computes `max_tokens`
from model capability; `openaiPayload.ts` emits flat role messages and a hashed `prompt_cache_key`.
Both route zod → JSON Schema through `harness/toolApiSchema.ts`, whose session-scoped cache keeps schema
churn from busting the prompt cache.

### TUI — `src/tui/`

`entrypoints/tui.tsx` is the only wiring point and startup order matters: focus-filter install must
precede Ink attaching stdin, and MCP trust prompts must happen before Ink owns stdin. It also builds the
`RuntimeSlot` + `SessionController` pair and hands them to `App` — those two carry all the
framework-agnostic session state, so a different shell replaces only the view layer. `App.tsx` is the
single stateful shell; `hooks/useAgentLoop.ts` renders the controller's event stream into Ink;
`hooks/useKeyboardShortcuts.ts` is the one global key handler (App holds no input state).

- **`createRuntime` is a factory closed over everything**, returning `{loop, planModeManager, …,
  dispose}`. Model switches, `/clear`, and resume replace the runtime — always via
  `RuntimeSlot.replace` (`src/runtime/runtimeSlot.ts`), which installs the new runtime *before*
  disposing the old one so a late dispose can't tear down its successor. The slot also owns the effort
  level, since clamping depends on the active model's `maxEffort`. **Runtime tool arrays are mutated in
  place** (`splice`) so MCP reconnects propagate into live subagent closures; never swap a tools array
  by identity.
- **`SessionController` (`src/runtime/sessionController.ts`) owns the turn lifecycle**: abort,
  checkpointing, token totals, tool-progress correlation, interrupt rollback. It exclusively owns the
  three `RecordProxy` handlers and republishes everything as one ordered `SessionEvent` stream plus a
  `useSyncExternalStore` snapshot. `turn-end` carries `aborted` (the signal) rather than "did it throw"
  — a *failed* turn is not aborted and still gets its duration summary. Only `transcript-reset` events
  with `bumpGeneration` remount Ink's `<Static>`; a rollback must not.
- **`transcript.ts` encodes the load-bearing TUI invariant:** Ink `<Static>` output cannot be retracted
  once a later sibling is emitted. Items live in `staticItems` / `liveItems` / `liveSystemItems` and are
  promoted in a strict order. Plain assistant messages go straight to static, so preceding live user
  messages must be committed first. Hidden tools (ToolSearch, plan tools, Task*, Skill, AskUserQuestion)
  render nothing but still mark group boundaries to preserve chronology.
- **`layout.ts` hand-duplicates the row arithmetic of the render components.** Changing a component's
  height without updating `estimate*Rows` causes flicker/overdraw (`test/tuiLayout.test.ts`).
- Import **`../ink.js`, not `ink`**, anywhere cursor or frame state matters — `src/tui/ink.tsx` is a
  façade over Ink internals providing `useDeclaredCursor` and alt-screen frame snapshot/restore.
- Colors come only from the frozen `theme` object in `src/tui/theme.ts`. `test/tuiTheme.test.ts` asserts
  neutral colors are exactly grayscale and makes *source-level* assertions about `Markdown.tsx` and
  `UserMessage.tsx`. Add a semantic key rather than a literal.
- Animation ticks off one shared clock (`clock/ClockContext.tsx`, 16ms) that pauses on terminal focus
  loss or overlay; don't add `setInterval` in components.
- The message queue is a **`MessageQueue` instance** owned by `App` (one per session, persisted as
  `message_queue` records); Enter always enqueues and a guarded effect pumps it. `subscribe`/
  `getSnapshot` are bound methods so `useSyncExternalStore` sees stable identities. The pump's guard is
  `canPumpQueue` (`src/runtime/queuePump.ts`), which separates "a turn is running" from "the UI is
  blocked" so a non-terminal shell can define the latter differently.
- Slash commands (`src/commands/`) are a module-level `Map` of plain `{name, description, run}` objects
  that render nothing — all effects go through optional `CommandContext` callbacks, so every command
  must tolerate `undefined` ones. Skill commands are prompt macros with per-invocation
  model/effort/tool overrides; built-ins always shadow same-named skills.

### Sessions & state — `src/sessions/`, `.myagent/`

Everything persistent lives under `<cwd>/.myagent/` (gitignored) via `src/utils/paths.ts`:
`config.json`, `settings.json`, `sessions/`, `skills/`, `agents/`, `plans/`, `shadow-git/`,
`session-memory/`. The two user-level exceptions are `~/.myagent/settings.json` and
`~/.myagent/config.json` (`getGlobalConfigPath()`), which every project reads as a base layer —
sessions, skills, and plans remain strictly per-project.

`SessionStore` writes `<id>.jsonl` append-only (`appendFileSync`, one JSON line, mode 0600); full
rewrites go through `writeFileAtomic` (tmp + rename). **New sessions are in-memory drafts** — nothing
touches disk until the first `message` record. `messageCount`/`title`/`updatedAt` are always *derived*;
`compactFailureCount`/`denialState` must be explicitly preserved on rewrites (easy to drop when adding a
path). Static class-level lock maps serialize mutations within a process (no cross-process safety).
Reads self-heal — index rebuild, legacy migration, malformed-line skipping — and report
`SessionDiagnostic[]` rather than throwing.

`services/checkpoint/` snapshots the working tree before every turn into a **separate shadow git repo**
at `.myagent/shadow-git/<sessionId>` with `core.worktree` pointed at the project root, so `/rewind`
never touches the user's real repo.

## Conventions

- **`import { z } from 'zod/v3'`** — never bare `zod` (26 call sites, zero exceptions).
- **Every relative import carries a `.js` extension** (NodeNext ESM, zero exceptions in `src/`).
- Schemas are `.strict()`.
- Prefer extracting pure functions and testing those over rendering components — that is why
  `layout.ts`, `transcript.ts`, `budget.ts`, `cli.ts`, and the suggestion modules are pure.
- Module-level env caches exist (e.g. `resetToolSearchCache`, `clearProjectContextCache`) — reset them
  in tests.
- Commit messages follow no consistent convention in this repo; match whatever the surrounding history
  does or keep it short and descriptive.

## Patches

`patches/` is applied by `postinstall` (patch-package); `ink` is pinned to `7.0.6`.
`ink+7.0.6.patch` adds CJK/full-width line breaking with kinsoku rules (via injected U+200B), a cursor
suffix fix, Windows Terminal resize reflow handling (`WT_SESSION`), and a reconciler use-after-free fix.
**`wrap-ansi+10.0.0.patch` is its required counterpart** — it teaches `wrap-ansi` to split on U+200B.
Changing one without the other breaks wrapping. `test/tuiInkPatch.test.ts` imports
`node_modules/ink/build/*` directly and fails if the patches aren't applied.
