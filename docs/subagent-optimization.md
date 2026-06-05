# Subagent System Optimization

This document describes the optimizations made to Hanekawa's subagent system, inspired by Claude Code's design.

## Changes Summary

### Phase 1: Differentiated Turn Limits

**File:** `src/tools/agentTool.ts`

Previously all built-in agent types used `DEFAULT_AGENT_MAX_TURNS = 30`. Now each agent type has its own default:

| Agent Type   | Previous | New |
|-------------|----------|-----|
| fork        | 30       | 200 |
| general     | 30       | 30  |
| explore     | 30       | 30  |
| plan        | 30       | 30  |

The fork agent gets a higher limit because it preloads large parent transcripts and needs extended exploration.

**Constants added:**
```typescript
const FORK_AGENT_MAX_TURNS = 200
const GENERAL_AGENT_MAX_TURNS = 30
const EXPLORE_AGENT_MAX_TURNS = 30
const PLAN_AGENT_MAX_TURNS = 30
```

`DEFAULT_AGENT_MAX_TURNS = 30` is kept as a fallback for custom agents that don't specify `maxTurns`.

---

### Phase 2: Expanded Tool Restrictions

**File:** `src/tools/agentTool.ts`

Added two new exported constants:

```typescript
// Tools that no sub-agent should ever call directly.
export const ALL_AGENT_DISALLOWED_TOOLS = [
  'Agent',
  'EnterPlanMode',
  'ExitPlanMode',
  'AskUserQuestion',
] as const

// Whitelist for background/async agents.
export const ASYNC_AGENT_ALLOWED_TOOLS = [
  'Read', 'Glob', 'Grep', 'Bash', 'Write', 'Edit', 'MultiEdit', 'Delete',
  'Skill',
] as const
```

`NESTED_AGENT_FORBIDDEN_TOOLS` is kept as a deprecated alias for backward compatibility.

**`filterToolsForSubAgent()` updated:**
```typescript
export function filterToolsForSubAgent(
  tools: Tool[],
  definition: BaseAgentDefinition = GENERAL_PURPOSE_AGENT,
  options?: { isBackground?: boolean },  // NEW optional parameter
): Tool[]
```

When `isBackground: true`, only tools in `ASYNC_AGENT_ALLOWED_TOOLS` are available.

---

### Phase 3: Async Agent Permission Avoidance

**File:** `src/tools/agentTool.ts`

Background agents now default to `'auto'` permission mode when the parent mode is not `'bypass'`. This prevents background agents from trying to prompt users (which they can't do anyway).

```typescript
function resolveSubagentPermissionMode(
  options: CreateAgentToolOptions,
  definition: BaseAgentDefinition,
  runInBackground: boolean = false,
): PermissionMode | undefined {
  const parentMode = options.permissionMode?.()
  if (parentMode === 'bypass') return 'bypass'
  if (definition.permissionMode) return definition.permissionMode
  if (runInBackground) return 'auto'  // NEW: background agents auto-approve
  return parentMode
}
```

**Priority order:**
1. Parent `bypass` mode always takes precedence
2. Explicit `permissionMode` in agent definition
3. `auto` mode for background agents (new)
4. Parent mode

---

### Phase 4: Fork Recursion Prevention

**File:** `src/tools/agentTool.ts`

Added a sentinel tag to detect recursive fork agents:

```typescript
const FORK_AGENT_BOILERPLATE_TAG = '__HANEKAWA_FORK_AGENT__'

const FORK_AGENT_BOILERPLATE = `# Forked Conversation Context
${FORK_AGENT_BOILERPLATE_TAG}
...`
```

In `runSubagent()`, before loading fork preload records:

```typescript
if (isForkAgent) {
  const parentRecords = await options.loadParentRecords?.()
  if (parentRecords?.some(r =>
    r.type === 'message' && typeof r.content === 'string' && r.content.includes(FORK_AGENT_BOILERPLATE_TAG)
  )) {
    throw new Error('Recursive fork agent detected. A fork agent cannot spawn another fork agent.')
  }
}
```

---

### Phase 5: Environment Variable Override

**File:** `src/tools/agentTool.ts`

Added support for environment variable model override:

```typescript
function resolveSubagentRuntime(...): ActiveModelRuntime {
  // Check per-type env var first, then generic
  const envModelType = process.env[`MYAGENT_SUBAGENT_MODEL_${subagentType.toUpperCase()}`]?.trim()
  const envModelGeneric = process.env.MYAGENT_SUBAGENT_MODEL?.trim()
  const envModel = envModelType || envModelGeneric

  if (envModel) {
    try {
      const runtime = options.resolveSubagentModel?.(subagentType, envModel)
      if (runtime) return runtime
    } catch {
      console.warn(`MYAGENT_SUBAGENT_MODEL="${envModel}" could not be resolved...`)
    }
  }
  // ... existing logic
}
```

**Supported environment variables:**
- `MYAGENT_SUBAGENT_MODEL` - Override model for all subagents
- `MYAGENT_SUBAGENT_MODEL_EXPLORE` - Override model for explore agents only
- `MYAGENT_SUBAGENT_MODEL_FORK` - Override model for fork agents only
- etc.

---

### Phase 6: CriticalSystemReminder for Custom Agents

**File:** `src/services/agents/agentDefinitionLoader.ts`

Added support for `criticalSystemReminder` field in custom agent frontmatter:

```yaml
---
name: my-agent
description: My custom agent
criticalSystemReminder: Stay focused and verify your findings.
---
You are a custom agent.
```

**Changes:**
1. Added `criticalSystemReminder` to `AgentFrontmatter` interface
2. Added parsing logic in `parse()` method
3. Included in returned definition

---

## Test Coverage

Added 22 new tests covering:

1. **Differentiated turn limits** (6 tests)
   - Fork agent maxTurns = 200
   - Other agents maxTurns = 30
   - Explicit maxTurns override

2. **Expanded tool restrictions** (4 tests)
   - ALL_AGENT_DISALLOWED_TOOLS includes new tools
   - ASYNC_AGENT_ALLOWED_TOOLS contents
   - Background agent tool filtering
   - Non-background agents unaffected

3. **Fork recursion prevention** (2 tests)
   - Rejects recursive fork
   - Allows normal fork

4. **Async permission avoidance** (3 tests)
   - Background agents use auto mode
   - Explicit permissionMode honored
   - Parent bypass takes precedence

5. **Environment variable override** (3 tests)
   - MYAGENT_SUBAGENT_MODEL override
   - Per-type override precedence
   - Invalid model falls through

6. **CriticalSystemReminder** (2 tests)
   - Loader parses field
   - Injected into system prompts

---

## Migration Guide

### Backward Compatibility

- All changes are additive
- `NESTED_AGENT_FORBIDDEN_TOOLS` kept as deprecated alias
- `filterToolsForSubAgent()` signature extended with optional parameter
- `DEFAULT_AGENT_MAX_TURNS` still used as fallback for custom agents

### Breaking Changes

None. All existing code should work without modification.

### New Features

1. **Higher turn limits for fork agents** - Fork agents now default to 200 turns instead of 30
2. **Background agent tool filtering** - Background agents only get tools from `ASYNC_AGENT_ALLOWED_TOOLS`
3. **Background agent auto-approve** - Background agents default to `auto` permission mode
4. **Fork recursion prevention** - Fork agents cannot spawn other fork agents
5. **Environment variable model override** - `MYAGENT_SUBAGENT_MODEL` env var
6. **CriticalSystemReminder for custom agents** - New frontmatter field

---

## Files Modified

1. `src/tools/agentTool.ts` - Main agent tool implementation
2. `src/services/agents/agentDefinitionLoader.ts` - Custom agent loader
3. `test/agentTool.test.ts` - Test file (22 new tests)

---

## Performance Impact

- Minimal overhead for fork recursion check (only loads records if forking)
- Environment variable check is O(1)
- No impact on non-background agents

---

## Future Improvements

1. **Memory scope support** - Implement user/project/local memory scopes
2. **Async agent record streaming** - Stream background agent progress to parent
3. **Agent priority system** - Prioritize agents based on type and context
4. **Dynamic turn limit adjustment** - Adjust limits based on task complexity
