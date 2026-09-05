# AGENTS.md

This file provides guidance for Codex and other coding agents when changing Hanekawa.

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
- **Every file tool reads through `src/tools/textFile.ts`**, which returns LF-normalized content plus the
  file's real `encoding`/`lineEndings`, and writes back through `writeTextFile`, which restores them.
  `ReadFileState.content` is therefore always LF, and it is what `Edit`/`MultiEdit` match against:
  the model writes LF line breaks, so matching raw CRLF content made every multi-line `oldString`
  find zero matches on Windows — deterministically, on every CRLF file. `applyLineEndings`
  normalizes before it joins, so a `newString` that already carries CRLF cannot end up doubled.
- `Edit` takes `replaceAll`; a zero-match failure is its own message (`noMatchFailure`, which names a
  whitespace or line-number-prefix cause when a laxer comparison would have hit), separate from the
  ambiguous-match one, which now says how to resolve it. `Read` takes `offset`/`limit` and returns
  `cat -n` numbering, but **always remembers the whole file** — a windowed read must not narrow what a
  later `Edit` can address, which is why there is no partial-view concept.
- `Grep`'s `path` may be a **file**. It is passed as ripgrep's argument with `-H`, never as its cwd, and
  `fast-glob` is skipped for it — handing a file to either is where the bare `ENOTDIR` came from. Ripgrep
  exiting **1 means no matches**, not "rg is missing"; only a spawn error falls back, and exit ≥2 raises
  with its stderr. Absolute paths are split past the `C:` drive prefix.
- `src/tools/inputAliases.ts` rewrites the model's parameter names to each tool's (`file_path` →
  `filePath`, `-i` → `caseInsensitive`, quoted `"30"` → `30`) in `ToolRunner.run` **before** anything
  reads the input, so permissions, hooks, `display.ts` and the persisted record all see one shape. It is
  deliberately not advertised — `toolApiSchema.ts` still publishes camelCase. Known-but-unsupported keys
  are **dropped, not rejected**. Tools whose `execute` needs a coerced value must get it here: the runner
  passes `call.input` itself, not zod's parsed output, so a schema `preprocess` would be inert.
- The prompt's `# Environment` shell line is `describeShell()` from `src/tools/bash.ts` — the shell the
  `Bash` tool will actually spawn, not a second guess at it. On Windows that is Git Bash before
  PowerShell, so the line names it as a POSIX shell and the model stops writing `NUL` and `%VAR%`.
- Project instructions are `AGENTS.md`/`CLAUDE.md` (and `.myagent/rules/*.md`) walked up from `cwd`, then
  `CLAUDE.local.md`/`AGENTS.local.md` from `cwd` alone. Both name lists are **first match wins per
  directory** (`firstExisting`): this repo keeps the two guides in sync, so reading both would send it
  twice every request. The loader emits them **outermost first**, so the nearest file overrides its
  ancestors and the local one is read last. `MYAGENT.md` is gone. `bootstrap`
  reads them once and passes them down as a getter (`getProjectContext`) through `SessionScopeDeps` to
  `createRuntime`, which captures the string for the loop and the Agent tool — so, like hooks, an edit
  needs a runtime rebuild: `reloadSettings()` re-reads the files and reports it in `needsRuntimeRebuild`.
- Thinking is the `thinking` setting, read in `createRuntime` and handed to the loop and the Agent
  tool: unset means `{ type: 'adaptive' }`, `false` means `{ type: 'disabled' }`, which is the only way
  the payload omits the parameter. `/thinking` writes the local layer, reloads settings, and updates the
  live loop; the desktop toggle writes it and rebuilds.

## Permissions and configuration

- Permission modes are `default`, `plan`, `acceptEdits`, `bypass`, and `readonly`. `bypass` still obeys
  deny/ask rules, Windows path safety, and protected paths (`.git`, `.vscode`, `.idea`, `.myagent`).
- **A configured `permissions.deny` rule is the only thing that denies without asking** (plus `readonly`
  mode, which is that refusal by definition). Everything else prompts. `bashSafety.ts`'s two severities
  say exactly this: `prompt` means "never auto-approve, ask", `deny` means "malformed enough that showing
  it decides nothing" — and every shell *syntax* finding (redirection, command substitution, backticks,
  ANSI-C quoting, unclosed quotes) is `prompt`, because a user can read a command and rule on it. They
  used to be `deny`, and `handleAutoDeny` refused the first two attempts silently while `toolRunner` told
  the model "User denied permission", so the model retried a call no human had seen. `handleAutoDeny` is
  now reached from the deny-rule branch alone; `blocksAutoApproval` is the separate "must ask" signal, and
  it is what an allow rule cannot override. `approveDetailed()` carries the reason that reaches the model
  — `approve()` stays as the boolean wrapper — and it must never claim a user denied what they never saw.
- Protected paths gate **writes only**: the list is Claude Code's `isDangerousFilePathToAutoEdit`, so
  `cat .git/config` and `Grep({path:'.myagent'})` are ordinary work. `isWriteOperation()` decides, reading
  `commandAnalysis.isReadOnly` for Bash and `tool.isReadOnly` otherwise.
- `extractFilePath()` (paths) and `extractRuleContent()` (rule matching) are separate on purpose: only the
  latter falls back to `input.command`. Never hand a whole shell command to `isProtectedPath` or
  `checkWindowsPathSafety` — `echo "done."` reads as a path component with a trailing dot. Windows path
  safety runs in **every** mode; it used to run only under `bypass`, the loosest one. It checks each path
  *component* where Claude Code checks the whole path's tail, which catches `a/.git./b` too — but only
  because `.` and `..` are exempt: without that exemption the trailing-dot rule fired on every `../file`,
  and since the check is bypass-immune that made ordinary parent-relative paths unapprovable-in-silence
  in every mode. A run of three or more dots as a whole component, and a DOS device name reached as a
  *suffix* (`settings.json.PRN`), are both suspicious.
- Discard redirections (`2>&1`, `>/dev/null`, `< /dev/null`, Windows `NUL`) neither read nor clobber a
  file, so `stripDiscardRedirections()` removes them before the read-only and complexity checks and
  `collectSyntaxIssues` does not report them. It is not `shellRuleMatching.ts`'s `stripOutputRedirections`,
  which also strips `> file` — a real write.
- Preserve the existing asymmetric shell rule matcher: deny/ask operates on command segments; allow does
  not use the same matching semantics. An allow rule may cover a *compound* only when every segment
  matches it, which is the same guarantee `buildSessionAllowRule` demands before offering one — so
  `complex shell command` alone no longer blocks always-allow and `git log | head` can be allowed for good.
- The auto-approval allowlists are ports of Claude Code's, and the deviations are deliberate.
  `commandAnalysis.ts` owns the **read-only shell allowlist** (`READ_ONLY_SHELL_COMMANDS` plus the
  per-command validators for `git`, `docker`, `fd`, `find`, `rg`, `sed` and the version-only
  interpreters); it omits `xargs`, which runs an arbitrary command and which `shellRuleMatching.ts`
  already refuses to suggest a prefix rule for, and the pager commands (`man`/`info`/`help`).
  `git tag`/`git branch` read only in listing form — an operand creates a ref unless `-l`/`--list` makes
  it a glob — `git config` needs an explicit `--get`/`--list`, and `--exec-path` is refused alongside
  `-c`/`--config-env`.
- `acceptEdits` adds `mkdir, touch, rm, rmdir, mv, cp, sed` (`ACCEPT_EDITS_BASH_COMMANDS`) on top of the
  edit tools, which now include `Delete` and `NotebookEdit`: with `rm` on the shell allowlist, excluding
  the tool only pushed the model onto the shell for the same effect. Every operand still has to pass
  `isSafeWorkspacePathOperand`, and `isLightWorkspaceShellWrite` permits exactly one command category
  (`destructive filesystem or git operation` — `rm -rf x/` and `sed -i` carry it by definition); a
  compound, an external side effect, unsafe syntax or a shell wrapper still prompts. Three details are
  what keep the operand scan honest, and each is a port of the corresponding Claude Code guard:
  `positionalArguments` honours the POSIX `--`, or `rm -rf src -- -/../../elsewhere` would present only
  `src` for checking; `mv`/`cp` take **no flags at all**, because a flag can carry the destination
  (`cp --target-directory=/etc a.txt`); and an accept-edits `sed` must match the substitution allowlist
  (`isAcceptEditsSedSubstitution`) — a single `s/…/…/flags` with `/` delimiters, `-i` plus only
  `-E`/`-r`/`--posix`, no `-e`, no `-f`, no `;` — with `hasDangerousSedScript` still run as the denylist.
- **No rule and no mode auto-approves a dangerous removal.** `isDangerousRemovalPath` (the filesystem
  root, a Windows drive root, `$HOME`, a direct child of either root, a bare `*`) feeds
  `blocksAutoApproval`, not just the accept-edits check, so an `Bash(rm:*)` allow rule cannot silently
  cover `rm -rf /`. This mirrors Claude Code, where `checkDangerousRemovalPaths` runs after deny rules
  but ahead of the allowlist.
- `WebFetch` is **not** a `safe` tool. `utils/permissions/webFetchDomains.ts` holds the preapproved
  documentation hosts (bare hostnames, plus the two path-scoped entries that must match on a segment
  boundary); those fetch without asking and everything else prompts. Rule content is
  `WebFetch(domain:example.com)` (`*.example.com` covers subdomains), which is also what always-allow
  writes — a host, because the next fetch of the same site is a different page.
- Rule tool names `Edit` and `Read` stand for their whole family (`RULE_TOOL_ALIASES`): an `Edit(...)`
  rule governs `Write`/`MultiEdit`/`Delete`/`NotebookEdit` and a `Read(...)` rule governs `Grep`/`Glob`.
  A rule naming one concrete tool still matches that tool alone. `extractFilePath` also reads
  `NotebookEdit`'s `notebook_path`, or a notebook write would skip every path check.
- `permissions.additionalDirectories` names extra roots accept-edits treats as workspace. It concatenates
  across layers like the rule groups but is written only when a layer declares one, and a subagent gate
  inherits the parent's resolved list via `getAdditionalDirectories()`.
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
- Deleting a model **repairs references instead of refusing**: `ConfigService.removeModel` re-points
  `defaultModel`/`fallbackModel`/`compactModel` to the next configured key (config insertion order, or
  drops the field) and sends any routing role that named it back to `inherit`. `removeEndpoint` cascades
  through `modelsForEndpoint` first, so an endpoint takes its models with it. The only remaining refusal
  is a *running* turn: `ShellHost.refuseIfModelIsInFlight` asks each lane's `LaneOccupant.activeModelKey()`
  before `applySettingsEffect`, so a rejection leaves the config untouched.
- `ModelConfig.longContext1m` is the **only beta not gated on `nativeAnthropic`**: `getAnthropicBetaHeaders`
  pushes `context-1m-2025-08-07` from it before the three native-only ones, because the endpoints that need
  the header to serve a 1M model are by definition not `anthropic.com` — `AnthropicProvider` therefore
  computes `betaHeaders()` once and sends it whatever the `baseUrl`, and `recordPromptState` hashes that same
  array so cache-break detection cannot disagree with the wire. It is **orthogonal to `contextWindow`** (the
  local token budget); neither may be inferred from the other or from the model name. `applyProviderChange`'s
  `set-model` rebuilds the whole `ModelConfig`, so the desktop form seeds the switch from the snapshot — an
  omitted field is how it is switched off.
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
- The settings screen is **optimistic**: `applySettingsIntent` parks every change it emits in
  `SettingsState.pending`, `settingsView` draws `projectSnapshot(snapshot, pending)` rather than the
  snapshot, and `runSettingsChanges` retires the batch by id whatever the outcome — a failure needs no
  rollback because the snapshot was never written. A removed row is *absent*; anything else is drawn with
  `SettingsRow.pending` / `SettingsButton.pending`. `busy` no longer gates input.
- `dom/settingsView.ts` keeps its cards, rows and form inputs **by id** and inserts through `reconcile`,
  for the reason the transcript does: a `replace()` of the column rebuilt the button under the pointer
  between `mousedown` and `mouseup`, so the first click on 保存 was never delivered. Form fields commit
  `live` (they write the draft, not the config); settings rows keep their `change` commit, and `textField`
  registers **one** of the two — a `live` field that also listened for `change` re-committed on the blur
  that a click on 保存 begins, which is that same swallowed click by another route.
- **A kept leaf is only half of it: the wrappers around it are kept too** (`.settings-row` and
  `.settings-row-control`, in both `rowNode` and `formNode`). `appendChild` moves a node by detaching it
  first, so a focused `<input>` put into a *newly built* cell leaves the document for that instant and the
  browser blurs it — once per character, since form fields commit `live`. That is why `test/helpers/domStub.ts`
  drops `activeElement` when a node leaves the tree: the old stub reported focus the real window had lost,
  so the model/provider form was untypable while every test stayed green.
- A repaint that takes the focused node anyway (a pill's shell is rebuilt whole) must not leave focus on
  `<body>`, or this screen's own keydown — Esc included — stops firing. `render()` re-focuses the container,
  and a menu that *just* opened focuses its first option, which is what `pillSelect`'s ArrowDown promises
  and could not do itself: the node it would focus does not exist until the render that toggle causes.
- A form and a delete confirmation are drawn **inside the card that owns them** (`SettingsForm.anchor`,
  `SettingsViewModel.confirming.anchor`), under the row when there is one. Never stacked at the top of the
  column — that put the form off-screen for anyone who had scrolled to the button that opened it.
- Every settings category except renderer-local `appearance` maps to one wire `scope`. 「技能和 MCP」 is
  `extensions`, and it owns the skill switch, the skill reload, the skill import and both MCP variants.
  `import-skill` carries an optional `sourceDir` for the reason `open-project` carries an optional `path`:
  without it the main process opens `onPickDirectory`, with it the smoke can drive it. The copy happens in
  `services/skills/importSkill.ts` **before** the reload, so a bad folder or a name already taken rejects
  the command instead of answering with an unchanged snapshot. A skill change
  rebuilds the project's lanes — a runtime is handed the skill list it was built with — and `app.ts` also
  calls `PaneSession.refreshCommands()`, because the composer's completion list is a renderer-side cache.
- Window-level views derive session identity from `WireLaneInfo`. Usage/cost/streaming belongs below the
  composer; model/effort belongs on its chip, permission mode on its pill, and session name in the header.
- The status line's counts are `model/usage.ts`'s `statusUsageView`: **入 / 命中 / 出 / 命中率**, session
  totals (`usage.total`, the same figures the cost beside it is computed from), and the rate's denominator
  is the input side alone — output can never be served from cache. It stays the **empty string** when
  nothing has been counted, because `#status` reserves no height. `cache_creation` is deliberately not a
  fifth number: `normalizeAnthropicUsage` folds cache writes into `inputTokens`, and splitting them would
  mean a new field on the persisted `TokenUsage`.
- Context occupancy is a ring on the chip ahead of the model name (`.chip-context-gauge`, a
  `conic-gradient` swept by `--context-ratio`), and its denominator is the **usable** window —
  `AgentLoop.getContextBudget().usableContextWindow`, i.e. `getAutoCompactThreshold`, not the raw
  `contextWindow`: the turn that crosses it is compacted, so a percentage of the raw window promises room
  no turn may use. Both numbers ride on `WireRuntimeSnapshot` and are read **off the loop**, so a fallback
  or plan-model switch reports the model actually in use. The used side is `contextUsedTokens` on the
  `snapshot` event — the provider's own `lastRequest` input + cache-read, else `countSessionRecordsTokens`
  memoised against `ledger.size` (that path runs per streamed chunk). The ring is `aria-hidden`; its
  figures reach the reader through the chip's `title`/`aria-label`, so colour is never the only carrier.
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
  The renderer draws the removal first: `app.ts` holds `deletingSessions` / `removingProjects`, `sidebarView`
  filters both (a deleted session must be skipped in the *lane* pass too, or the still-open lane redraws it),
  and both sets are always cleared in a `finally` — the next `refreshSessions()` is the truth either way.
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
  a mutable ref instead of closing over the paint that built it — and that ref must be keyed by a
  key some `node()` call claims that paint (`prune()` drops every other ref, which leaves the kept
  head holding the first paint's answer: the thinking row opened and would not close).
- The group head carries a **stable accessible name** (`groupHeaderName`) while its visible label is
  `aria-hidden` and tracks the turn; what is new is said by the current step's head. It has **no bead
  strip**. The bead is the tool step's only *visual* status vocabulary
  (`awaiting-approval`/`running`/`done`/`failed`) and is `aria-hidden` — the state reaches the head's
  accessible name in words, because colour may not be the only carrier. Steps are not cards: no third
  shadow or radius rung, and depth stays two steps.
- `stepCount` counts a turn's **actions** (`isActionStep`: tool, task, subagent), not `steps.length` —
  thinking, staged prose and system notices are rows in the group but not work it did. Zero is a real
  answer, and `groupHeaderLabel` drops the counter rather than saying 「0 步」.
- A message carries one meta row under it (`.item-meta`: 复制 · model · time, in that order), revealed on
  `:hover`/`:focus-within` and absent entirely on a streaming draft, which has neither model nor stamp.
  The two labels are `aria-hidden` (the transcript is `aria-live`); the copy button is not. The clipboard
  call belongs to `paneSession.ts` via `onCopy` — `dom/transcriptView.ts` runs against a DOM stub.
  On the user's side the row is *outside* the bubble: `.item.user` is the right-hugging column, the
  surface is its own `.user-bubble` node, and the row hangs off that bubble's bottom-left corner.
- The **live status** stays at the *top* of the turn (`model/waiting.ts`'s `turnActivity`): while a turn
  streams it is drawn on that turn's **group head** (`.group-head.live`, found by the state's own
  `turnId`), reading `groupActivityLabel` — the running tool's *name* only, else 「正在思考」 — and it
  seals to `groupHeaderLabel`'s 「已处理 …」 only when `isStreaming` goes false. `ActivityGroup.status`
  says `done` between two tool calls and must not be used for liveness. The standalone `.waiting` row is
  the same four pieces (`liveParts`) for the gap *before* the turn has a group, and it withdraws for an
  arriving draft — never both carriers at once. The label is announced on the row and `aria-hidden` on the
  head (which keeps its stable name); the bead, counter and `Esc 中断` hint are always `aria-hidden`, and
  the counter appears only past `WAITING_CLOCK_AFTER_MS` (5s) — `waitingElapsedLabel` returns the empty
  string below it and the sheet hides an empty counter. The counter is the view's only timer:
  `paneSession.ts` stamps `turnStartedAt` on `turn-start`, and `deactivate`/`dispose` call
  `transcriptView.stopClock()`.
- Nothing in a step may widen the reading column: the scroller's `overflow-y: auto` computes `overflow-x`
  to `auto`, so an unshrinkable row turns the whole conversation into a horizontal scroller. `.transcript`
  declares `overflow-x: clip` as the backstop, but it must stay with nothing to do: `min-width: 0` runs the
  whole chain (`.transcript-column`, `.activity-group`, `.group-steps`, `.step`, `.step-head`,
  `.step-body`, `.search-file`, `.search-hit`, `.step-code-row`), a head's arguments (`.step-summary`) are
  one ellipsized line, `.step-head` wraps, and the bodies wrap (`pre-wrap` + `overflow-wrap`) and cap
  themselves with `overflow-y: auto` + `overflow-x: clip`. **Nothing in a group truncates**: a head's
  arguments (`.step-summary`), both heads' labels and the search list's paths and hits all wrap with
  `overflow-wrap: anywhere` — for a `Grep` or a `Bash` the arguments *are* the step, an ellipsis takes the
  end of the path (the file name), and the body answers a different question than the head does. Both heads
  carry `flex-wrap: wrap`, and `min-width: 0` has to sit on the box the text is in, since `button()` puts it
  in a `nowrap` `.btn-label` a flex container's own rules cannot reach. **`.diff` is the one
  block in a turn allowed a horizontal scrollbar** (its columns have to line up); a fenced code block wraps
  like everything else, and `.md .md-table` is `table-layout: fixed` so a wide table cannot outgrow the
  measure. `rendererStyleTokens.test.ts` pins both lists exhaustively.
- Disclosure stores the user's **absolute** answer per group and step id (`model/thinking.ts`), never a
  deviation from a default. The defaults are dynamic (a running turn is open with only its last step open;
  failures open themselves; an awaiting-approval step does not) and are pruned on `transcript-reset`.
- The task panel is a resident in-flow strip inside `.composer-column` above `#composer` — not a
  `#composer-popovers` layer — read-only, drawn during permission requests too, and absent entirely when
  no checklist exists. Tool display strings reach the renderer as the `toolDisplays` DTO projection of
  `src/tools/display.ts`; the renderer must not guess tool input keys.
- A session row is capped at the rail: `.project-body` is a grid (its fold animates `grid-template-rows`),
  and a grid's implicit `auto` column is sized to its item's **max-content** — the widest un-wrapped
  session title. Without `grid-template-columns: minmax(0, 1fr)` (and `.project-rows`'s `min-width: 0`) a
  long name grew the row to ~650px inside a 280px rail, the `overflow: hidden` cropped everything past the
  edge, and what the crop takes is `.session-actions`: the delete button became unreachable and the name
  never truncated. `.session-title` gives way; `.session-actions` is `flex: 0 0 auto`.
- Too long a name **scrolls on hover** instead of only ellipsizing, and it is a **loop, not a shuttle**:
  `.session-title` is the clipper, `.session-title-text` is the track (a plain inline at rest,
  `inline-flex` only while moving, because `transform` skips non-replaced inline boxes), and it holds two
  siblings: `.session-title-run`, the name the row shows, and `.session-title-echo`, an `aria-hidden`
  second copy that is `display: none` until the marquee runs — the name is a node so nothing reading the
  row gets it twice —
  the track travels exactly one copy plus `--marquee-gap`, which is the offset where the echo has reached
  the original's starting pixels, so the restart has no seam. Scrolling back would be reading backwards.
  `model/marquee.ts` owns the arithmetic — a constant, slow `MARQUEE_SPEED` with deliberately **no
  duration cap**, since an even drift is the whole effect — plus `MARQUEE_GAP`, which is `--marquee-gap`'s
  other half. The animation is `linear` (one of two in the sheet that may be) after a delay, so a pointer
  crossing the rail does not set rows lunging. `dom/sidebarView.ts` measures `scrollWidth - clientWidth`
  on `mouseenter`/`focusin` **only** — the list repaints once per streamed token, and measuring during
  `render()` would force a layout per row at that rate — and re-runs the hovered row's measurement at the
  end of `render()`, because a repaint replaces the node under a pointer that never moved and
  `mouseenter` will not fire again.
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
  localStorage key. `app.ts` writes it with `setProperty` — TypeScript may write **custom properties**
  and, of the real ones, only the composer's `height` — and `body.resizing` suspends the collapse
  transition for the drag's duration.
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
