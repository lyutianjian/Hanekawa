# Plan Mode in Claude Code: Design & Implementation Reference

A deep-dive into how Plan Mode works in the Claude Code CLI — covering architecture, state management, prompt engineering, permissions, subagent integration, and all relevant source files.

---

## Table of Contents

1. [Overview](#overview)
2. [Entry & Exit Mechanisms](#entry--exit-mechanisms)
3. [State Management](#state-management)
4. [Plan File Storage](#plan-file-storage)
5. [Prompt Engineering](#prompt-engineering)
6. [Permission System](#permission-system)
7. [Subagent Integration](#subagent-integration)
8. [Model Selection](#model-selection)
9. [Context Compaction](#context-compaction)
10. [UI Components](#ui-components)
11. [Configuration & Feature Flags](#configuration--feature-flags)
12. [Key Source Files](#key-source-files)

---

## Overview

Plan Mode is a **permission mode** in Claude Code that constrains the model to read-only exploration and planning before implementation. It is not a separate execution path — it is a value of `PermissionMode` (`'plan'`) that triggers behavioral changes via prompt injection, permission context manipulation, and UI state.

**Core design principle**: Plan Mode restrictions are enforced at the **prompt level**, not the code level. All tools remain available in the tool registry; the model is instructed not to use non-read-only tools (except the plan file).

```
┌─────────────────────────────────────────────────────────┐
│                     Plan Mode Flow                       │
│                                                          │
│  User/Model ──► EnterPlanMode ──► PermissionMode='plan' │
│       │                                │                 │
│       │         Attachment system      │                 │
│       │         injects workflow       │                 │
│       │         instructions each turn │                 │
│       │                                │                 │
│       │    ┌─── Explore (read-only) ◄──┘                 │
│       │    ├─── Plan Agent (read-only)                   │
│       │    ├─── Write/Edit plan file                     │
│       │    └─── AskUserQuestion                          │
│       │                  │                               │
│       │         ExitPlanMode ──► User approval dialog    │
│       │                  │                               │
│       │         Restore prePlanMode ──► Implementation   │
└─────────────────────────────────────────────────────────┘
```

---

## Entry & Exit Mechanisms

### Entry: Three Paths

#### 1. Model-Initiated (EnterPlanMode Tool)

**File**: `src/tools/EnterPlanModeTool/EnterPlanModeTool.ts`

The model calls `EnterPlanMode` when it determines a task needs planning. Key behavior:

- `shouldDefer: true` — requires user approval via permission dialog
- `isReadOnly()` returns `true`
- Disabled when `--channels` is active (Telegram/Discord) to prevent plan mode from becoming a trap with no exit dialog
- **Blocked inside agent/subagent contexts** (line 78): `throw new Error('EnterPlanMode tool cannot be used in agent contexts')`

On `call()`:
1. Fires `handlePlanModeTransition(currentMode, 'plan')` for state tracking
2. Sets permission mode to `'plan'` via `applyPermissionUpdate(prepareContextForPlanMode(context))`
3. Returns tool result with workflow instructions (either full 5-phase or brief interview-phase message)

#### 2. User-Initiated (`/plan` Command)

**File**: `src/commands/plan/plan.tsx`

The `/plan` slash command toggles plan mode. If not in plan mode, enters it using the same `handlePlanModeTransition` + `applyPermissionUpdate` + `prepareContextForPlanMode` flow. If already in plan mode, displays the current plan or opens it in an external editor via `/plan open`.

#### 3. Settings / CLI Flags

**File**: `src/utils/permissions/permissionSetup.ts` (line 689)

- `settings.permissions.defaultMode: 'plan'` — starts every session in plan mode
- `--permission-mode plan` CLI flag
- Teammates spawned with `plan_mode_required` start in plan mode

### Exit: ExitPlanMode Tool

**File**: `src/tools/ExitPlanModeTool/ExitPlanModeV2Tool.ts`

The `ExitPlanMode` tool is the only sanctioned way to leave plan mode. Key behavior:

- `shouldDefer: true` — requires user approval
- `requiresUserInteraction()` returns `true` for non-teammates
- `isReadOnly()` returns `false` (writes plan to disk)
- `validateInput()` rejects if not currently in plan mode

**On `call()` (lines 243-417)**:
1. Reads plan from disk via `getPlan(context.agentId)`
2. If CCR web UI sent an edited plan, syncs it to disk
3. For teammates with `plan_mode_required`: sends `plan_approval_request` to team lead via mailbox, returns `awaitingLeaderApproval: true`
4. For main session:
   - Sets `hasExitedPlanMode(true)` and `needsPlanModeExitAttachment(true)`
   - Restores permission mode from `prePlanMode` (defaults to `'default'`)
   - Handles auto-mode circuit breaker: if `prePlanMode === 'auto'` but gate is now off, falls back to `'default'`
   - Restores stripped dangerous permissions if not restoring to auto mode
   - Returns approved plan text in tool result for model reference during implementation

**User Approval Dialog**: `src/components/permissions/ExitPlanModePermissionRequest/ExitPlanModePermissionRequest.tsx`

Offers multiple options:
- "Yes, bypass permissions" / "Yes, accept edits"
- "Yes, accept edits (keep context)" / "Yes, default (keep context)"
- "Resume auto mode" (if auto mode was active)
- "No" (reject, stay in plan mode with feedback)
- Ctrl+G to edit the plan in external editor
- Shift+Tab for quick auto-accept

---

## State Management

### PermissionMode

**File**: `src/types/permissions.ts`

```typescript
// External (user-facing) modes
export const EXTERNAL_PERMISSION_MODES = [
  'acceptEdits', 'bypassPermissions', 'default', 'dontAsk', 'plan'
] as const

// Internal modes (added at runtime)
export type InternalPermissionMode = ExternalPermissionMode | 'auto' | 'bubble'
export type PermissionMode = InternalPermissionMode
```

`'plan'` is a first-class member of the permission mode union. It flows through the same permission checking pipeline as all other modes.

### ToolPermissionContext

**File**: `src/types/permissions.ts` (lines 427-441)

```typescript
type ToolPermissionContext = {
  readonly mode: PermissionMode
  readonly additionalWorkingDirectories: ReadonlyMap<string, AdditionalWorkingDirectory>
  readonly alwaysAllowRules: ToolPermissionRulesBySource
  readonly alwaysDenyRules: ToolPermissionRulesBySource
  readonly alwaysAskRules: ToolPermissionRulesBySource
  readonly isBypassPermissionsModeAvailable: boolean
  readonly strippedDangerousRules?: ToolPermissionRulesBySource
  readonly shouldAvoidPermissionPrompts?: boolean
  readonly awaitAutomatedChecksBeforeDialog?: boolean
  readonly prePlanMode?: PermissionMode   // stores mode before plan entry
}
```

The `prePlanMode` field is the key mechanism: it stashes the current mode when entering plan mode so it can be restored on exit.

### Bootstrap State

**File**: `src/bootstrap/state.ts`

Session-level tracking fields:
- `hasExitedPlanMode` (line 157) — whether plan mode was exited this session (for re-entry guidance)
- `needsPlanModeExitAttachment` (line 159) — one-time flag to inject exit notification into message stream
- `planSlugCache` (line 169) — maps sessionId to plan file slug

Accessor functions:
- `hasExitedPlanModeInSession()` / `setHasExitedPlanMode()` (lines 1333-1339)
- `needsPlanModeExitAttachment()` / `setNeedsPlanModeExitAttachment()` (lines 1341-1347)
- `handlePlanModeTransition(fromMode, toMode)` (lines 1349-1363) — handles the one-shot attachment flag logic

### AppState

**File**: `src/state/AppStateStore.ts`

- `toolPermissionContext` (line 109) — contains the current `mode` including `'plan'`
- `initialMessage` (lines 402-410) — when plan mode exits with context clear, REPL sets this to trigger a fresh query with the plan content and new permission mode
- `pendingPlanVerification` (lines 411-416) — stores plan content for background verification after plan mode exit

---

## Plan File Storage

**File**: `src/utils/plans.ts`

### Directory

Default: `~/.claude/plans/` (from `getClaudeConfigHomeDir() + '/plans'`). Overridable via `settings.plansDirectory`. The path is validated to stay within the project root to prevent path traversal.

### File Naming

Plans use a word-slug naming scheme. Each session gets a unique slug via `generateWordSlug()`, cached per-session in `planSlugCache`:

- **Main session**: `{slug}.md`
- **Subagents**: `{slug}-agent-{agentId}.md`

### Key Functions

| Function | Line | Purpose |
|----------|------|---------|
| `getPlanSlug(sessionId?)` | 32 | Lazily generates and caches a unique slug |
| `setPlanSlug(sessionId, slug)` | 54 | Restores slug for resumed sessions |
| `clearPlanSlug(sessionId?)` | 62 | Called on `/clear` |
| `getPlansDirectory()` | 79 | Returns (and memoizes) the plans directory path |
| `getPlanFilePath(agentId?)` | 119 | Returns full path to plan file |
| `getPlan(agentId?)` | 135 | Reads plan content from disk |
| `copyPlanForResume(log, targetSessionId?)` | 164 | Recovers plan file when resuming a session |
| `copyPlanForFork(log, targetSessionId)` | 239 | Copies plan with NEW slug for forked sessions |
| `recoverPlanFromMessages(log)` | 279 | Searches message history for plan content |
| `persistFileSnapshotIfRemote()` | 360 | Saves plan as `SystemFileSnapshotMessage` for CCR sessions |

### Plan Recovery

`recoverPlanFromMessages()` (line 279) searches backward through message history for plan content in three forms:

1. **ExitPlanMode tool_use input** — `normalizeToolInput` injects plan content into tool_use input
2. **`planContent` field on user messages** — set during "clear context and implement" flow
3. **`plan_file_reference` attachment** — created by auto-compact to preserve plan across compaction

---

## Prompt Engineering

Plan Mode does **not** modify the base system prompt. Instead, it uses a multi-layered prompt injection strategy.

### Layer 1: Tool Prompts

#### EnterPlanMode Tool Prompt

**File**: `src/tools/EnterPlanModeTool/prompt.ts`

`getEnterPlanModeToolPrompt()` (line 166) returns different prompts for internal (`ant`) vs external users:

- **External prompt** (line 16): Detailed guide with 7 conditions for when to use plan mode, when not to, and examples
- **Ant prompt** (line 101): More restrained, only recommends plan mode for genuinely ambiguous tasks

#### ExitPlanMode Tool Prompt

**File**: `src/tools/ExitPlanModeTool/prompt.ts`

Instructs the model to use ExitPlanMode when the plan is written and ready for user approval, and NOT to use it for research tasks.

### Layer 2: Tool Result Instructions

When `EnterPlanMode` is called, `mapToolResultToToolResultBlockParam` returns instructions that either say:
- "DO NOT write or edit any files except the plan file. Detailed workflow instructions will follow." (interview phase)
- A full 6-step plan mode workflow (standard phase)

### Layer 3: Attachment-Based Prompt Injection (Core Mechanism)

**File**: `src/utils/attachments.ts`

Plan mode instructions are injected as **user-message attachments** wrapped in `<system-reminder>` tags, NOT as system prompt modifications. This is the primary mechanism for controlling model behavior during plan mode.

#### Attachment Types

| Type | Line | Trigger | Content |
|------|------|---------|---------|
| `plan_mode` | 565 | Every turn in plan mode | Full workflow instructions (with throttling) |
| `plan_mode_reentry` | 572 | One-time on re-entry | "Read existing plan first" guidance |
| `plan_mode_exit` | 576 | One-time on exit | "You can now make edits" notification |
| `plan_file_reference` | 592 | Auto-compact | Preserves plan content across compaction |

#### Throttling

**Config**: `PLAN_MODE_ATTACHMENT_CONFIG` (line 259)
- `TURNS_BETWEEN_ATTACHMENTS: 5`
- `FULL_REMINDER_EVERY_N_ATTACHMENTS: 5`

**Logic** in `getPlanModeAttachments()` (line 1186):
- First turn always gets a **full** attachment
- Subsequent turns alternate full/sparse every 5 turns
- Sparse reminders are 1-2 sentences referencing "see full instructions earlier"

### Layer 4: Workflow Instructions

**File**: `src/utils/messages.ts`

#### Standard 5-Phase Workflow

`getPlanModeV2Instructions()` (line 3207) — The primary workflow:

```
Phase 1: Initial Understanding
  - Launch up to {exploreAgentCount} Explore agents IN PARALLEL
  - Use 1 agent for isolated tasks, multiple for uncertain scope
  - Focus on understanding existing patterns and reusable code

Phase 2: Design
  - Launch up to {agentCount} Plan agent(s)
  - Provide comprehensive background context from Phase 1
  - Request detailed implementation plan

Phase 3: Review
  - Read critical files identified by agents
  - Ensure alignment with user's original request
  - Use AskUserQuestion for remaining questions

Phase 4: Final Plan
  - Write plan to plan file (only editable file)
  - Structure varies by experiment variant (see below)

Phase 5: Call ExitPlanMode
  - Turn must end with AskUserQuestion OR ExitPlanMode
  - Never ask about plan approval via text
```

The key instruction (line 3227):
```
Plan mode is active. The user indicated that they do not want you to execute yet --
you MUST NOT make any edits (with the exception of the plan file mentioned below),
run any non-readonly tools (including changing configs or making commits), or otherwise
make any changes to the system. This supercedes any other instructions you have received.
```

#### Phase 4 Experiment Variants

Controlled by `getPewterLedgerVariant()` via `tengu_pewter_ledger` feature flag:

| Variant | Description |
|---------|-------------|
| `control` (default) | Context section, recommended approach, file paths, verification |
| `trim` | One-line Context, single verification command |
| `cut` | No Context/Background section, under 40 lines |
| `cap` | Hard 40-line limit, no prose, no restating the request |

#### Iterative Interview Workflow

`getPlanModeInterviewInstructions()` (line 3323) — Alternative to the 5-phase workflow, enabled by `isPlanModeInterviewPhaseEnabled()`:

```
The Loop (repeat until plan is complete):
  1. Explore — Read code, look for patterns to reuse
  2. Update plan file — Capture findings immediately
  3. Ask user — When hitting ambiguity, use AskUserQuestion, then go to step 1

First Turn: Scan key files, write skeleton plan, ask first questions
When to Converge: All ambiguities resolved, covers what/which/how/verify
```

#### Subagent Instructions

`getPlanModeV2SubAgentInstructions()` (line 3399) — Simpler instructions for subagents operating in plan mode. Focuses on read-only exploration and plan file writing.

#### Sparse Instructions

`getPlanModeV2SparseInstructions()` (line 3385) — A 1-2 sentence reminder injected after the first full instruction to avoid repeating the full workflow every turn.

---

## Permission System

### Plan Mode as a Permission Mode

**File**: `src/utils/permissions/permissions.ts`

Plan mode (`mode === 'plan'`) is treated as a standard permission mode. There is **no code-level enforcement** that blocks non-read-only tools. The restriction is purely prompt-level — the model still has access to all tools but is instructed not to use them (except the plan file).

### Plan Mode + Bypass Permissions

In `permissions.ts` (lines 1262-1280):

```typescript
const shouldBypassPermissions =
  appState.toolPermissionContext.mode === 'bypassPermissions' ||
  (appState.toolPermissionContext.mode === 'plan' &&
    appState.toolPermissionContext.isBypassPermissionsModeAvailable)
```

If the user was originally in `bypassPermissions` mode and entered plan mode, all tools are still auto-allowed. The `isBypassPermissionsModeAvailable` flag persists through the plan mode transition.

### Plan Mode + Auto Mode

When `TRANSCRIPT_CLASSIFIER` feature is enabled, plan mode can have the auto-mode classifier active. Controlled by `shouldPlanUseAutoMode()` in `permissionSetup.ts` (lines 1446-1455).

When active, the classifier runs for tools that return `ask` instead of directly prompting the user.

### prepareContextForPlanMode

**File**: `src/utils/permissions/permissionSetup.ts` (line 1462)

This function handles the transition into plan mode:

```typescript
export function prepareContextForPlanMode(context): ToolPermissionContext {
  const currentMode = context.mode
  if (currentMode === 'plan') return context

  if (feature('TRANSCRIPT_CLASSIFIER')) {
    if (currentMode === 'auto') {
      if (shouldPlanUseAutoMode()) {
        return { ...context, prePlanMode: 'auto' }  // keep auto active
      }
      // Deactivate auto, restore dangerous permissions
      autoModeStateModule?.setAutoModeActive(false)
      return { ...restoreDangerousPermissions(context), prePlanMode: 'auto' }
    }
    if (shouldPlanUseAutoMode() && currentMode !== 'bypassPermissions') {
      autoModeStateModule?.setAutoModeActive(true)
      return { ...stripDangerousPermissionsForAutoMode(context), prePlanMode: currentMode }
    }
  }

  return { ...context, prePlanMode: currentMode }  // stash current mode
}
```

### transitionPermissionMode

**File**: `src/utils/permissions/permissionSetup.ts` (line 597)

Centralized mode transition handler. For plan mode:
- **Entry**: Calls `prepareContextForPlanMode(context)` to stash the current mode
- **Exit**: Clears `prePlanMode`, sets `hasExitedPlanMode(true)`

### Mode Cycling (Shift+Tab)

**File**: `src/utils/permissions/getNextPermissionMode.ts` (lines 34-79)

The cycle order: `default → acceptEdits → plan → bypassPermissions/auto → default`

For `ant` (Anthropic internal) users, `acceptEdits` and `plan` are skipped: `default → bypassPermissions/auto → default`

### BashTool Read-Only Validation

**File**: `src/tools/BashTool/readOnlyValidation.ts`

In plan mode, Bash commands are validated against a read-only allowlist. Commands like `git status`, `ls`, `cat`, `grep`, `find`, `wc` are considered read-only and auto-allowed. Write commands like `rm`, `mkdir`, `git commit` are not.

---

## Subagent Integration

### Agent Tool Restrictions in Plan Mode

**File**: `src/constants/tools.ts` (line 36)

```typescript
export const ALL_AGENT_DISALLOWED_TOOLS = new Set([
  TASK_OUTPUT_TOOL_NAME,
  EXIT_PLAN_MODE_V2_TOOL_NAME,    // subagents cannot exit plan mode
  ENTER_PLAN_MODE_TOOL_NAME,       // subagents cannot enter plan mode
  ...(process.env.USER_TYPE === 'ant' ? [] : [AGENT_TOOL_NAME]),
  ASK_USER_QUESTION_TOOL_NAME,
  TASK_STOP_TOOL_NAME,
  ...
])
```

Subagents **cannot** enter or exit plan mode. Plan mode is a "main thread abstraction" — only the primary conversation can manage it.

### Built-in Plan Agent

**File**: `src/tools/AgentTool/built-in/planAgent.ts`

```typescript
export const PLAN_AGENT: BuiltInAgentDefinition = {
  agentType: 'Plan',
  whenToUse: 'Software architect agent for designing implementation plans...',
  disallowedTools: [
    AGENT_TOOL_NAME, EXIT_PLAN_MODE_TOOL_NAME,
    FILE_EDIT_TOOL_NAME, FILE_WRITE_TOOL_NAME, NOTEBOOK_EDIT_TOOL_NAME,
  ],
  source: 'built-in',
  tools: EXPLORE_AGENT.tools,
  model: 'inherit',
  omitClaudeMd: true,
  getSystemPrompt: () => getPlanV2SystemPrompt(),
}
```

The Plan agent's system prompt (`getPlanV2SystemPrompt()`, line 14) enforces:
- **Strict read-only mode**: No file creation, modification, deletion, or state changes
- **Exploration mandate**: Use Glob, Grep, FileRead, and Bash (read-only commands only)
- **Design output**: Step-by-step implementation strategy with trade-offs
- **Required output format**: Ends with "Critical Files for Implementation" list

### Built-in Explore Agent

**File**: `src/tools/AgentTool/built-in/exploreAgent.ts`

- `agentType`: `"Explore"`
- `disallowedTools`: Same as Plan — strictly read-only
- `model`: `'haiku'` for external users, `'inherit'` for ants
- `omitClaudeMd: true` — saves tokens

### ONE_SHOT_BUILTIN_AGENT_TYPES

**File**: `src/tools/AgentTool/constants.ts`

```typescript
export const ONE_SHOT_BUILTIN_AGENT_TYPES = new Set(['Explore', 'Plan'])
```

Explore and Plan agents skip the agentId/SendMessage/usage trailer since they are never continued, saving ~135 chars per run across 34M+ weekly Explore spawns.

### Agent Count Configuration

**File**: `src/utils/planModeV2.ts`

| Function | Default | Max/Enterprise/Team |
|----------|---------|---------------------|
| `getPlanModeV2AgentCount()` | 1 | 3 |
| `getPlanModeV2ExploreAgentCount()` | 3 | 3 |

### Agent Permission Mode Override

**File**: `src/tools/AgentTool/runAgent.ts` (lines 415-498)

Agent definitions can specify their own `permissionMode` (e.g., `"plan"`), which overrides the parent's unless the parent is in `bypassPermissions`, `acceptEdits`, or `auto` mode.

### Read-Only Agent Optimizations

**File**: `src/tools/AgentTool/runAgent.ts` (lines 388-410)

Explore and Plan agents omit CLAUDE.md from context and gitStatus from system context to save tokens (~5-15 Gtok/week across 34M+ Explore spawns).

---

## Model Selection

**File**: `src/utils/model/model.ts` (line 150)

`getRuntimeMainLoopModel()` adjusts the model for plan mode:

| Setting | Normal Mode | Plan Mode |
|---------|-------------|-----------|
| `opusplan` | Default model | Upgraded to Opus (unless message exceeds 200k tokens) |
| `haiku` | Haiku | Upgraded to Sonnet |

**File**: `src/query.ts` (line 576)

When in plan mode with Opus, the query pipeline checks if the most recent assistant message exceeds 200k tokens to decide whether to fall back from Opus plan mode.

### Agent Model Resolution

**File**: `src/utils/model/agent.ts` (line 37)

Priority order for subagent model selection:
1. `CLAUDE_CODE_SUBAGENT_MODEL` env var override
2. Tool-specified `model` parameter
3. Agent definition's `model` field
4. Default: `'inherit'` (inherits parent's model)

---

## Context Compaction

**File**: `src/services/compact/compact.ts` (line 1542)

`createPlanModeAttachmentIfNeeded()` ensures that after context compaction, a full `plan_mode` attachment is re-injected so the model remembers it's in plan mode and follows the correct workflow. This prevents the model from "forgetting" plan mode constraints after context window compression.

---

## UI Components

### EnterPlanMode Permission Request

**File**: `src/components/permissions/EnterPlanModePermissionRequest/EnterPlanModePermissionRequest.tsx`

Explains what plan mode does (explore codebase, identify patterns, design strategy, present plan). On "yes", calls `handlePlanModeTransition()` and applies `setMode: 'plan'`.

### ExitPlanMode Permission Request

**File**: `src/components/permissions/ExitPlanModePermissionRequest/ExitPlanModePermissionRequest.tsx`

Rich approval dialog with:
- Plan review and external editor editing (Ctrl+G)
- Permission mode selection for return (default, acceptEdits, auto, bypass)
- Prompt-based permission rules (e.g., "run tests", "install dependencies")
- "Ultraplan" option for multi-agent parallel planning
- Shift+Tab for quick auto-accept

### Plan Messages

| Component | Purpose |
|-----------|---------|
| `PlanApprovalMessage.tsx` | Team plan approval request/response rendering |
| `UserPlanMessage.tsx` | Plan content display |
| `RejectedPlanMessage.tsx` | Rejected plan display |

### Theme

**File**: `src/utils/theme.ts`

Plan mode uses a dedicated color: `planMode` — a muted teal. Used throughout the UI for plan mode indicators.

---

## Configuration & Feature Flags

### planModeV2.ts

**File**: `src/utils/planModeV2.ts`

| Config | Gate | Description |
|--------|------|-------------|
| `getPlanModeV2AgentCount()` | Subscription tier | Number of Plan agents (1-3) |
| `getPlanModeV2ExploreAgentCount()` | Default 3 | Number of Explore agents |
| `isPlanModeInterviewPhaseEnabled()` | `tengu_plan_mode_interview_phase` flag or env var | Gates iterative interview workflow |
| `getPewterLedgerVariant()` | `tengu_pewter_ledger` flag | Controls Phase 4 plan structure experiment |

### Environment Variables

| Variable | Effect |
|----------|--------|
| `CLAUDE_CODE_PLAN_MODE_INTERVIEW_PHASE` | Enables interview workflow |

### Settings

| Setting | Effect |
|---------|--------|
| `permissions.defaultMode: 'plan'` | Start sessions in plan mode |
| `plansDirectory` | Custom plan file storage location |

---

## Key Source Files

### Core Tools

| File | Purpose |
|------|---------|
| `src/tools/EnterPlanModeTool/EnterPlanModeTool.ts` | EnterPlanMode tool implementation |
| `src/tools/EnterPlanModeTool/constants.ts` | Tool name constant |
| `src/tools/EnterPlanModeTool/prompt.ts` | When-to-use prompt (external vs ant) |
| `src/tools/EnterPlanModeTool/UI.tsx` | UI rendering |
| `src/tools/ExitPlanModeTool/ExitPlanModeV2Tool.ts` | ExitPlanMode tool implementation |
| `src/tools/ExitPlanModeTool/constants.ts` | Tool name constant |
| `src/tools/ExitPlanModeTool/prompt.ts` | When-to-use prompt |
| `src/tools/ExitPlanModeTool/UI.tsx` | UI rendering |

### Plan File Management

| File | Purpose |
|------|---------|
| `src/utils/plans.ts` | Plan file storage, slug management, recovery, snapshots |

### Prompt Engineering

| File | Lines | Purpose |
|------|-------|---------|
| `src/utils/messages.ts` | 3136-3417 | Plan mode instruction generation (5-phase, interview, sparse, subagent) |
| `src/utils/attachments.ts` | 259, 564-592, 1186-1260 | Attachment types, throttling, generation |

### Permission System

| File | Purpose |
|------|---------|
| `src/types/permissions.ts` | Core type definitions (PermissionMode, ToolPermissionContext) |
| `src/utils/permissions/permissionSetup.ts` | `prepareContextForPlanMode()`, mode transitions |
| `src/utils/permissions/permissions.ts` | Permission checking logic |
| `src/utils/permissions/PermissionMode.ts` | Mode config (title, symbol, color) |
| `src/utils/permissions/getNextPermissionMode.ts` | Shift+Tab mode cycling |

### State Management

| File | Purpose |
|------|---------|
| `src/bootstrap/state.ts` | Session-level plan mode tracking |
| `src/state/AppStateStore.ts` | AppState with toolPermissionContext |

### Subagent System

| File | Purpose |
|------|---------|
| `src/tools/AgentTool/AgentTool.tsx` | Agent tool implementation |
| `src/tools/AgentTool/runAgent.ts` | Agent execution engine |
| `src/tools/AgentTool/built-in/planAgent.ts` | Plan agent definition |
| `src/tools/AgentTool/built-in/exploreAgent.ts` | Explore agent definition |
| `src/tools/AgentTool/builtInAgents.ts` | Built-in agent assembly |
| `src/tools/AgentTool/agentToolUtils.ts` | Tool filtering for agents |
| `src/tools/AgentTool/loadAgentsDir.ts` | Agent definition loading |
| `src/tools/AgentTool/prompt.ts` | Agent tool prompt construction |
| `src/tools/AgentTool/constants.ts` | Agent constants |
| `src/utils/forkedAgent.ts` | Subagent context factory |

### Model Selection

| File | Purpose |
|------|---------|
| `src/utils/model/model.ts` | Runtime model selection (opusplan, haiku upgrade) |
| `src/utils/model/agent.ts` | Agent model resolution |
| `src/query.ts` | Query pipeline with plan mode model fallback |

### UI

| File | Purpose |
|------|---------|
| `src/components/permissions/EnterPlanModePermissionRequest/EnterPlanModePermissionRequest.tsx` | Enter dialog |
| `src/components/permissions/ExitPlanModePermissionRequest/ExitPlanModePermissionRequest.tsx` | Exit dialog |
| `src/commands/plan/plan.tsx` | `/plan` slash command |
| `src/utils/theme.ts` | Plan mode color (muted teal) |

### Configuration

| File | Purpose |
|------|---------|
| `src/utils/planModeV2.ts` | Agent counts, interview phase, plan structure experiment |
| `src/constants/tools.ts` | Agent disallowed tools |
| `src/services/compact/compact.ts` | Post-compaction plan mode preservation |
