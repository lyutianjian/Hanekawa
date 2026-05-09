# MyAgent CLI MVP Design

## Goal

MyAgent is a minimal runnable CLI coding agent inspired by Claude Code's core architecture. The first version focuses on a strong agent harness, high-quality prompt constraints, context management, long-lived resumable sessions, JSON-configured model providers, local tools, MCP calls, skills, and an init command.

The MVP is intentionally not a full Claude Code clone. It should stay lean and avoid advanced feature seams that would make the project bloated.

## Explicit Non-Goals

The MVP will not implement or reserve interfaces for:

- IDE integration
- LSP jump/navigation
- Plugin systems
- Remote bridge
- Multi-agent orchestration
- Background tasks
- Cron or loop automation

## Architecture

Use TypeScript with Node.js or Bun. Keep the structure close to Claude Code's command/tool/service/harness separation, but reduce scope.

```text
myagent/
├── src/
│   ├── entrypoints/
│   │   └── cli.ts
│   ├── main.ts
│   ├── commands/
│   │   ├── init.ts
│   │   ├── model.ts
│   │   ├── resume.ts
│   │   ├── session.ts
│   │   ├── mcp.ts
│   │   ├── skills.ts
│   │   └── index.ts
│   ├── tools/
│   │   ├── grep.ts
│   │   ├── readFile.ts
│   │   ├── editFile.ts
│   │   ├── writeFile.ts
│   │   ├── deleteFile.ts
│   │   ├── mcpTool.ts
│   │   └── index.ts
│   ├── services/
│   │   ├── api/
│   │   ├── config/
│   │   ├── session/
│   │   ├── mcp/
│   │   └── skills/
│   ├── harness/
│   │   ├── loop.ts
│   │   ├── contextBuilder.ts
│   │   ├── contextBudget.ts
│   │   ├── toolRunner.ts
│   │   ├── permissions.ts
│   │   └── types.ts
│   ├── prompts/
│   │   ├── system.ts
│   │   ├── harness.ts
│   │   ├── coding.ts
│   │   ├── safety.ts
│   │   ├── outputFormat.ts
│   │   └── index.ts
│   └── ui/
│       └── repl.ts
├── .myagent/
│   ├── config.json
│   ├── mcp.json
│   ├── skills/
│   └── sessions/
└── package.json
```

The first UI can use `readline/promises`. React + Ink is not part of the MVP.

## Startup Flow

When `myagent` starts without flags, it should not silently restore the last session. It should ask the user to choose:

1. Create a new session
2. Resume the most recent session
3. Choose from session history

Supported entry modes:

```bash
myagent
myagent --new
myagent --resume <session-id>
myagent --version
myagent init
```

The REPL supports:

```text
/resume
/resume <session-id>
/session
/session list
/session new
/session title <name>
/model
/model list
/model providers
/model use <provider>/<model>
/model add-from-json <path>
/mcp list
/mcp connect <name>
/mcp tools
/skills list
/skills use <name>
/compact
/exit
```

## Agent Harness

The harness is the center of the system. It is responsible for context assembly, prompt composition, model calls, tool execution, tool-result feedback, and session persistence.

```text
User input
  ↓
CommandRouter
  ├─ slash command → local command
  └─ normal input → AgentLoop
                 ↓
          ContextBuilder
                 ↓
          PromptComposer
                 ↓
          ApiClient
                 ↓
          tool_use?
             ├─ yes → PermissionGate → ToolRunner → append tool_result → continue
             └─ no  → render final response
                 ↓
          SessionStore append
```

Harness rules:

- The model cannot directly modify files; it must use tools.
- Tool results are the source of truth.
- Existing files must be read before editing.
- File deletion always requires explicit user approval.
- Dangerous commands default to denial unless the user explicitly approves them.
- Every model call records provider and model.
- Every tool call records input, result, risk level, and approval state.

Core interfaces:

```ts
interface Tool {
  name: string
  description: string
  inputSchema: unknown
  riskLevel: 'safe' | 'confirm' | 'dangerous'
  execute(input: unknown, context: ToolContext): Promise<ToolResult>
}

interface Command {
  name: string
  description: string
  run(args: string[], context: CommandContext): Promise<void>
}

interface ModelProvider {
  name: string
  createMessage(request: ModelRequest): Promise<ModelResponse>
}
```

## Prompt Design

Prompt quality is part of the MVP, not a later enhancement. Prompts should be modular and composed per request.

```text
System Contract
+ Harness Instructions
+ Coding Rules
+ Safety Rules
+ Output Format Rules
+ Project Context
+ Session Context
+ Active Skills
+ Tool Definitions
```

Prompt modules live under `src/prompts/`.

Core behavioral constraints:

```text
You are MyAgent, a CLI coding agent.
You help with software engineering tasks in the current working directory.
Do not claim a file changed unless a tool confirms it.
Use tools when repository state matters.
Before editing an existing file, read it first.
Never delete files without explicit user approval.
When uncertain, ask or inspect.
Do not invent command output, file paths, or API behavior.
Tool results override assumptions.
Prefer concise, structured answers.
```

Default output formats:

```text
Normal answer:
- Conclusion
- Evidence
- Next step

Code change:
- Changes
- Validation
- Notes

Failure:
- Failure reason
- Confirmed facts
- Suggested next step
```

## Context Management

MyAgent should take advantage of modern long-context models while still keeping sessions sustainable.

ContextBuilder assembles:

- system prompt
- harness rules
- project instructions from `MYAGENT.md`, `CLAUDE.md`, or `AGENTS.md`
- active session summary
- recent messages
- relevant recent tool results
- active skill content
- tool definitions

Budget strategy:

```text
0% - 70%:
  Keep full current session messages.

70% - 85%:
  Keep recent messages verbatim.
  Compress old tool results to summaries.

85% - 95%:
  Compact early conversation into session summary.
  Keep recent interaction verbatim.

95%+:
  Ask the user to run /compact or confirm automatic compaction.
```

The MVP can begin with approximate token estimation, but it must have a dedicated `ContextBudgetManager` so the behavior is explicit and testable.

## Sessions

Sessions are long-lived resumable conversation windows, not one file per user turn.

```text
.myagent/sessions/
├── index.json
└── <session-id>/
    ├── session.json
    ├── messages.jsonl
    ├── approvals.jsonl
    └── artifacts/
```

`index.json` tracks session history:

```json
{
  "sessions": [
    {
      "id": "2026-05-08-abc123",
      "title": "myagent design",
      "cwd": "C:/Users/Miyano/Documents/code/myagent",
      "createdAt": "2026-05-08T00:00:00.000Z",
      "updatedAt": "2026-05-08T00:00:00.000Z",
      "messageCount": 42,
      "lastModel": "anthropic-main/claude-sonnet-4-6"
    }
  ]
}
```

`session.json` stores the active window state:

```json
{
  "id": "2026-05-08-abc123",
  "title": "myagent design",
  "cwd": "C:/Users/Miyano/Documents/code/myagent",
  "activeProvider": "anthropic-main",
  "activeModel": "claude-sonnet-4-6",
  "contextState": {
    "summary": "",
    "compactedUntilMessageId": null,
    "tokenEstimate": 0
  }
}
```

`messages.jsonl` is append-only:

```jsonl
{"type":"message","role":"user","content":"...","createdAt":"..."}
{"type":"message","role":"assistant","content":"...","model":"...","createdAt":"..."}
{"type":"tool_use","tool":"grep","input":{},"createdAt":"..."}
{"type":"tool_result","toolUseId":"...","content":"...","createdAt":"..."}
```

`/resume` behavior:

```text
/resume
  Show historical sessions and let the user choose one.

/resume <session-id>
  Restore that session directly.
```

On startup, the user chooses new/resume/history instead of automatic restoration.

## API and Model Configuration

Model access is JSON-configured so users can connect different API sites and models without code changes.

`.myagent/config.json`:

```json
{
  "defaultProvider": "anthropic-main",
  "defaultModel": "claude-sonnet-4-6",
  "providers": {
    "anthropic-main": {
      "type": "anthropic",
      "baseURL": "https://api.anthropic.com",
      "apiKeyEnv": "ANTHROPIC_API_KEY",
      "models": ["claude-opus-4-7", "claude-sonnet-4-6"]
    },
    "openai-compatible": {
      "type": "openai-compatible",
      "baseURL": "https://example.com/v1",
      "apiKeyEnv": "OPENAI_COMPAT_API_KEY",
      "models": ["gpt-4.1", "deepseek-chat", "qwen-max"],
      "headers": {}
    }
  }
}
```

Supported provider types:

- `anthropic`
- `openai-compatible`

No provider plugin system is included.

## Built-in Tools

MVP tools:

- `grep`
- `readFile`
- `editFile`
- `writeFile`
- `deleteFile`
- `mcpTool`

Risk levels:

```text
safe:
- grep
- readFile

confirm:
- editFile
- writeFile for a new file
- MCP tool with unknown side effects

dangerous:
- deleteFile
- overwrite existing file
- destructive MCP tool
```

Deletion rules:

- `deleteFile` always requires explicit confirmation.
- Deletion cannot be performed indirectly through `editFile`.
- Auto-confirm settings cannot bypass deletion confirmation.
- Approval records are appended to `approvals.jsonl`.

## Init Command

`myagent init` and `/init` scan the current project and generate `MYAGENT.md`.

Inputs to inspect:

- `package.json`
- README files
- `tsconfig.json`
- git status
- top-level directory structure
- common scripts and commands

Generated sections:

- Project Overview
- Development Commands
- Architecture
- Code Conventions
- Testing / Validation
- Agent Notes

If `MYAGENT.md` already exists, prompt the user:

1. merge
2. overwrite
3. cancel

Default is cancel.

## MCP

MCP configuration lives in `.myagent/mcp.json`.

Example:

```json
{
  "servers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
    }
  }
}
```

MVP supports stdio MCP servers only.

Commands:

```text
/mcp list
/mcp connect <name>
/mcp tools
```

Connected MCP tools are mapped into harness tools and pass through the same permission gate.

## Skills

Skills are local markdown instruction packages.

```text
.myagent/skills/<name>/SKILL.md
```

Frontmatter:

```yaml
name: debugging
description: Use when diagnosing bugs or failures
```

Commands:

```text
/skills list
/skills use <name>
```

In the MVP, using a skill injects its content into the active context. There is no skill marketplace, plugin lifecycle, or version manager.

## Validation

The MVP should be validated with a small manual and automated checklist:

```text
typecheck
myagent --version
myagent init
myagent --new
startup new/resume/history prompt
normal multi-turn conversation
/model list
/model use <provider>/<model>
grep tool call
readFile tool call
editFile with prior read
writeFile new file confirmation
deleteFile explicit confirmation
/session list
/resume
/skills list
/skills use <name>
/mcp list
```

## Open Decisions Closed by This Design

- The first version uses readline instead of Ink.
- Startup asks whether to resume or create a session.
- Sessions are long-lived append-only windows.
- API/model access is driven by JSON provider config.
- Deletion and sensitive operations always require explicit user approval.
- Advanced Claude Code features are out of scope and do not receive placeholder interfaces.
