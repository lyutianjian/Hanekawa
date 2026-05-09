# MyAgent CLI MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a minimal runnable MyAgent CLI with a Claude Code-inspired harness, prompt/context management, resumable sessions, JSON-configured model providers, local tools, init, MCP, skills, and sensitive-operation confirmation.

**Architecture:** Implement a small TypeScript CLI under `myagent/` with clear command/tool/service/harness boundaries. Start with readline-based REPL and a provider abstraction; keep high-end features out of scope. Each feature is testable through focused Node test files using the built-in `node:test` runner.

**Tech Stack:** TypeScript, Node.js ESM, `tsx` for development, `node:test`, `@anthropic-ai/sdk`, `openai`, `@modelcontextprotocol/sdk`, `yaml`, `zod`, `fast-glob`.

---

## File Structure

Create all source under `myagent/`.

```text
myagent/
├── package.json                    # scripts and dependencies
├── tsconfig.json                    # TypeScript ESM config
├── src/
│   ├── entrypoints/cli.ts           # executable entrypoint and argv parsing
│   ├── main.ts                      # app bootstrap
│   ├── commands/                    # slash and top-level commands
│   ├── harness/                     # agent loop, context, permissions, tool runner
│   ├── prompts/                     # modular prompt text
│   ├── services/                    # api/config/session/mcp/skills services
│   ├── tools/                       # built-in tools
│   ├── ui/repl.ts                   # readline UI
│   └── utils/                       # filesystem/json/path helpers
└── test/                            # node:test coverage
```

Use `.myagent/` inside the user's current working directory at runtime, not inside `myagent/` source by default.

---

### Task 1: Project Scaffold and Core Types

**Files:**
- Create: `myagent/package.json`
- Create: `myagent/tsconfig.json`
- Create: `myagent/src/harness/types.ts`
- Create: `myagent/src/utils/paths.ts`
- Create: `myagent/src/utils/json.ts`
- Create: `myagent/test/utils.test.ts`

- [ ] **Step 1: Create package metadata**

Write `myagent/package.json`:

```json
{
  "name": "myagent",
  "version": "0.1.0",
  "type": "module",
  "bin": {
    "myagent": "./src/entrypoints/cli.ts"
  },
  "scripts": {
    "dev": "tsx src/entrypoints/cli.ts",
    "typecheck": "tsc --noEmit",
    "test": "node --import tsx --test test/**/*.test.ts"
  },
  "dependencies": {
    "@anthropic-ai/sdk": "latest",
    "@modelcontextprotocol/sdk": "latest",
    "fast-glob": "latest",
    "openai": "latest",
    "yaml": "latest",
    "zod": "latest"
  },
  "devDependencies": {
    "@types/node": "latest",
    "tsx": "latest",
    "typescript": "latest"
  }
}
```

- [ ] **Step 2: Create TypeScript config**

Write `myagent/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "outDir": "dist"
  },
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

- [ ] **Step 3: Define core harness types**

Write `myagent/src/harness/types.ts`:

```ts
export type RiskLevel = 'safe' | 'confirm' | 'dangerous'

export type ChatRole = 'user' | 'assistant' | 'system' | 'tool'

export interface ChatMessage {
  id: string
  role: ChatRole
  content: string
  createdAt: string
  model?: string
}

export interface ToolUseRecord {
  id: string
  type: 'tool_use'
  tool: string
  input: unknown
  riskLevel: RiskLevel
  createdAt: string
}

export interface ToolResultRecord {
  id: string
  type: 'tool_result'
  toolUseId: string
  tool: string
  ok: boolean
  content: string
  createdAt: string
}

export type SessionRecord =
  | ({ type: 'message' } & ChatMessage)
  | ToolUseRecord
  | ToolResultRecord

export interface ToolContext {
  cwd: string
  sessionId: string
  readFiles: Set<string>
}

export interface ToolResult {
  ok: boolean
  content: string
  metadata?: Record<string, unknown>
}

export interface Tool {
  name: string
  description: string
  inputSchema: unknown
  riskLevel: RiskLevel
  execute(input: unknown, context: ToolContext): Promise<ToolResult>
}

export interface CommandContext {
  cwd: string
  writeLine(message: string): void
}

export interface Command {
  name: string
  description: string
  run(args: string[], context: CommandContext): Promise<void>
}

export interface ToolCall {
  id: string
  name: string
  input: unknown
}

export interface ModelRequest {
  system: string
  messages: ChatMessage[]
  tools: Tool[]
  model: string
}

export interface ModelResponse {
  content: string
  toolCalls: ToolCall[]
}

export interface ModelProvider {
  name: string
  createMessage(request: ModelRequest): Promise<ModelResponse>
}
```

- [ ] **Step 4: Add path helpers**

Write `myagent/src/utils/paths.ts`:

```ts
import path from 'node:path'

export function getMyAgentDir(cwd: string): string {
  return path.join(cwd, '.myagent')
}

export function getConfigPath(cwd: string): string {
  return path.join(getMyAgentDir(cwd), 'config.json')
}

export function getMcpConfigPath(cwd: string): string {
  return path.join(getMyAgentDir(cwd), 'mcp.json')
}

export function getSessionsDir(cwd: string): string {
  return path.join(getMyAgentDir(cwd), 'sessions')
}

export function getSkillsDir(cwd: string): string {
  return path.join(getMyAgentDir(cwd), 'skills')
}
```

- [ ] **Step 5: Add JSON helpers**

Write `myagent/src/utils/json.ts`:

```ts
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

export async function readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const raw = await readFile(filePath, 'utf8')
    return JSON.parse(raw) as T
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback
    throw error
  }
}

export async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}
```

- [ ] **Step 6: Write utility tests**

Write `myagent/test/utils.test.ts`:

```ts
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import { getConfigPath, getMyAgentDir } from '../src/utils/paths.js'
import { readJsonFile, writeJsonFile } from '../src/utils/json.js'

test('path helpers resolve .myagent paths under cwd', () => {
  const cwd = path.join('tmp', 'project')
  assert.equal(getMyAgentDir(cwd), path.join(cwd, '.myagent'))
  assert.equal(getConfigPath(cwd), path.join(cwd, '.myagent', 'config.json'))
})

test('json helpers read fallback and write formatted json', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-json-'))
  try {
    const file = path.join(dir, 'nested', 'config.json')
    assert.deepEqual(await readJsonFile(file, { ok: false }), { ok: false })
    await writeJsonFile(file, { ok: true })
    assert.deepEqual(await readJsonFile(file, { ok: false }), { ok: true })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
```

- [ ] **Step 7: Install dependencies**

Run: `cd myagent && npm install`

Expected: `package-lock.json` is created and install exits with code 0.

- [ ] **Step 8: Run tests and typecheck**

Run: `cd myagent && npm test && npm run typecheck`

Expected: tests pass and TypeScript reports no errors.

- [ ] **Step 9: Commit**

```bash
git add myagent/package.json myagent/package-lock.json myagent/tsconfig.json myagent/src/harness/types.ts myagent/src/utils/paths.ts myagent/src/utils/json.ts myagent/test/utils.test.ts
git commit -m "feat: scaffold myagent core types"
```

---

### Task 2: Config Service and Provider Registry

**Files:**
- Create: `myagent/src/services/config/types.ts`
- Create: `myagent/src/services/config/configService.ts`
- Create: `myagent/src/services/api/providerRegistry.ts`
- Create: `myagent/test/config.test.ts`

- [ ] **Step 1: Define config types**

Write `myagent/src/services/config/types.ts`:

```ts
export type ProviderType = 'anthropic' | 'openai-compatible'

export interface ProviderConfig {
  type: ProviderType
  baseURL: string
  apiKeyEnv: string
  models: string[]
  headers?: Record<string, string>
}

export interface MyAgentConfig {
  defaultProvider: string
  defaultModel: string
  providers: Record<string, ProviderConfig>
}

export const defaultConfig: MyAgentConfig = {
  defaultProvider: 'anthropic-main',
  defaultModel: 'claude-sonnet-4-6',
  providers: {
    'anthropic-main': {
      type: 'anthropic',
      baseURL: 'https://api.anthropic.com',
      apiKeyEnv: 'ANTHROPIC_API_KEY',
      models: ['claude-opus-4-7', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001']
    }
  }
}
```

- [ ] **Step 2: Implement config service**

Write `myagent/src/services/config/configService.ts`:

```ts
import { getConfigPath } from '../../utils/paths.js'
import { readJsonFile, writeJsonFile } from '../../utils/json.js'
import { defaultConfig, MyAgentConfig } from './types.js'

export class ConfigService {
  constructor(private readonly cwd: string) {}

  async load(): Promise<MyAgentConfig> {
    const config = await readJsonFile<MyAgentConfig>(getConfigPath(this.cwd), defaultConfig)
    this.validateActiveModel(config)
    return config
  }

  async save(config: MyAgentConfig): Promise<void> {
    this.validateActiveModel(config)
    await writeJsonFile(getConfigPath(this.cwd), config)
  }

  async mergeFromJsonFile(filePath: string): Promise<MyAgentConfig> {
    const current = await this.load()
    const incoming = await readJsonFile<Partial<MyAgentConfig>>(filePath, {})
    const merged: MyAgentConfig = {
      defaultProvider: incoming.defaultProvider ?? current.defaultProvider,
      defaultModel: incoming.defaultModel ?? current.defaultModel,
      providers: {
        ...current.providers,
        ...(incoming.providers ?? {})
      }
    }
    await this.save(merged)
    return merged
  }

  private validateActiveModel(config: MyAgentConfig): void {
    const provider = config.providers[config.defaultProvider]
    if (!provider) throw new Error(`Unknown default provider: ${config.defaultProvider}`)
    if (!provider.models.includes(config.defaultModel)) {
      throw new Error(`Model ${config.defaultModel} is not listed for provider ${config.defaultProvider}`)
    }
  }
}
```

- [ ] **Step 3: Implement provider registry skeleton**

Write `myagent/src/services/api/providerRegistry.ts`:

```ts
import { ModelProvider } from '../../harness/types.js'
import { MyAgentConfig, ProviderConfig } from '../config/types.js'

class NotConfiguredProvider implements ModelProvider {
  constructor(
    public readonly name: string,
    private readonly providerConfig: ProviderConfig
  ) {}

  async createMessage(): Promise<never> {
    const apiKey = process.env[this.providerConfig.apiKeyEnv]
    if (!apiKey) throw new Error(`Missing API key environment variable: ${this.providerConfig.apiKeyEnv}`)
    throw new Error(`Provider ${this.name} is registered but API client is not implemented yet`)
  }
}

export class ProviderRegistry {
  constructor(private readonly config: MyAgentConfig) {}

  getActiveProvider(): ModelProvider {
    const providerConfig = this.config.providers[this.config.defaultProvider]
    if (!providerConfig) throw new Error(`Unknown provider: ${this.config.defaultProvider}`)
    return new NotConfiguredProvider(this.config.defaultProvider, providerConfig)
  }

  listModels(): string[] {
    return Object.entries(this.config.providers).flatMap(([providerName, provider]) =>
      provider.models.map(model => `${providerName}/${model}`)
    )
  }

  setActive(providerName: string, model: string): MyAgentConfig {
    const provider = this.config.providers[providerName]
    if (!provider) throw new Error(`Unknown provider: ${providerName}`)
    if (!provider.models.includes(model)) throw new Error(`Unknown model for ${providerName}: ${model}`)
    return {
      ...this.config,
      defaultProvider: providerName,
      defaultModel: model
    }
  }
}
```

- [ ] **Step 4: Write config tests**

Write `myagent/test/config.test.ts`:

```ts
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import { ConfigService } from '../src/services/config/configService.js'
import { ProviderRegistry } from '../src/services/api/providerRegistry.js'

test('config service creates and validates default config', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-config-'))
  try {
    const service = new ConfigService(dir)
    const config = await service.load()
    assert.equal(config.defaultProvider, 'anthropic-main')
    assert.ok(config.providers['anthropic-main'].models.includes(config.defaultModel))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('config service merges provider json', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-config-'))
  try {
    const extra = path.join(dir, 'providers.json')
    await writeFile(extra, JSON.stringify({
      providers: {
        local: {
          type: 'openai-compatible',
          baseURL: 'http://localhost:1234/v1',
          apiKeyEnv: 'LOCAL_API_KEY',
          models: ['local-model']
        }
      }
    }), 'utf8')
    const service = new ConfigService(dir)
    const config = await service.mergeFromJsonFile(extra)
    assert.equal(config.providers.local.models[0], 'local-model')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('provider registry lists and switches configured models', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-config-'))
  try {
    const config = await new ConfigService(dir).load()
    const registry = new ProviderRegistry(config)
    assert.ok(registry.listModels().includes('anthropic-main/claude-sonnet-4-6'))
    const next = registry.setActive('anthropic-main', 'claude-opus-4-7')
    assert.equal(next.defaultModel, 'claude-opus-4-7')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
```

- [ ] **Step 5: Run tests and typecheck**

Run: `cd myagent && npm test && npm run typecheck`

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add myagent/src/services/config myagent/src/services/api/providerRegistry.ts myagent/test/config.test.ts
git commit -m "feat: add myagent config service"
```

---

### Task 3: Long-Lived Session Store

**Files:**
- Create: `myagent/src/services/session/sessionStore.ts`
- Create: `myagent/test/session.test.ts`

- [ ] **Step 1: Implement session store**

Write `myagent/src/services/session/sessionStore.ts`:

```ts
import { mkdir, readFile, readdir, writeFile, appendFile } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { SessionRecord } from '../../harness/types.js'
import { getSessionsDir } from '../../utils/paths.js'
import { readJsonFile, writeJsonFile } from '../../utils/json.js'

export interface SessionIndexEntry {
  id: string
  title: string
  cwd: string
  createdAt: string
  updatedAt: string
  messageCount: number
  lastModel?: string
}

export interface SessionIndex {
  sessions: SessionIndexEntry[]
}

export interface SessionState {
  id: string
  title: string
  cwd: string
  activeProvider: string
  activeModel: string
  contextState: {
    summary: string
    compactedUntilMessageId: string | null
    tokenEstimate: number
  }
}

export class SessionStore {
  constructor(private readonly cwd: string) {}

  async create(provider: string, model: string, title = 'New session'): Promise<SessionState> {
    const now = new Date().toISOString()
    const id = `${now.slice(0, 10)}-${randomUUID().slice(0, 8)}`
    const state: SessionState = {
      id,
      title,
      cwd: this.cwd,
      activeProvider: provider,
      activeModel: model,
      contextState: {
        summary: '',
        compactedUntilMessageId: null,
        tokenEstimate: 0
      }
    }
    await mkdir(this.sessionDir(id), { recursive: true })
    await writeJsonFile(this.sessionFile(id), state)
    await writeFile(this.messagesFile(id), '', 'utf8')
    await writeFile(this.approvalsFile(id), '', 'utf8')
    await this.upsertIndex({
      id,
      title,
      cwd: this.cwd,
      createdAt: now,
      updatedAt: now,
      messageCount: 0,
      lastModel: `${provider}/${model}`
    })
    return state
  }

  async list(): Promise<SessionIndexEntry[]> {
    const index = await this.readIndex()
    return index.sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  async load(id: string): Promise<SessionState> {
    return readJsonFile<SessionState>(this.sessionFile(id), undefined as never)
  }

  async appendRecord(id: string, record: SessionRecord): Promise<void> {
    await appendFile(this.messagesFile(id), `${JSON.stringify(record)}\n`, 'utf8')
    const state = await this.load(id)
    const records = await this.readRecords(id)
    await this.upsertIndex({
      id,
      title: state.title,
      cwd: state.cwd,
      createdAt: records[0]?.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messageCount: records.filter(record => record.type === 'message').length,
      lastModel: `${state.activeProvider}/${state.activeModel}`
    })
  }

  async readRecords(id: string): Promise<SessionRecord[]> {
    const raw = await readFile(this.messagesFile(id), 'utf8')
    return raw.split('\n').filter(Boolean).map(line => JSON.parse(line) as SessionRecord)
  }

  async recordApproval(id: string, approval: unknown): Promise<void> {
    await appendFile(this.approvalsFile(id), `${JSON.stringify({ ...approval, createdAt: new Date().toISOString() })}\n`, 'utf8')
  }

  async hasAnySessions(): Promise<boolean> {
    try {
      const entries = await readdir(getSessionsDir(this.cwd))
      return entries.length > 0
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
  }

  private async readIndex(): Promise<SessionIndex> {
    return readJsonFile<SessionIndex>(this.indexFile(), { sessions: [] })
  }

  private async upsertIndex(entry: SessionIndexEntry): Promise<void> {
    const index = await this.readIndex()
    const sessions = index.sessions.filter(session => session.id !== entry.id)
    sessions.push(entry)
    await writeJsonFile(this.indexFile(), { sessions })
  }

  private indexFile(): string {
    return path.join(getSessionsDir(this.cwd), 'index.json')
  }

  private sessionDir(id: string): string {
    return path.join(getSessionsDir(this.cwd), id)
  }

  private sessionFile(id: string): string {
    return path.join(this.sessionDir(id), 'session.json')
  }

  private messagesFile(id: string): string {
    return path.join(this.sessionDir(id), 'messages.jsonl')
  }

  private approvalsFile(id: string): string {
    return path.join(this.sessionDir(id), 'approvals.jsonl')
  }
}
```

- [ ] **Step 2: Write session tests**

Write `myagent/test/session.test.ts`:

```ts
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import { SessionStore } from '../src/services/session/sessionStore.js'

test('session store creates long-lived session and appends records', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-session-'))
  try {
    const store = new SessionStore(dir)
    const session = await store.create('anthropic-main', 'claude-sonnet-4-6', 'Test session')
    await store.appendRecord(session.id, {
      type: 'message',
      id: 'm1',
      role: 'user',
      content: 'hello',
      createdAt: '2026-05-08T00:00:00.000Z'
    })
    const records = await store.readRecords(session.id)
    assert.equal(records.length, 1)
    assert.equal(records[0].type, 'message')
    const listed = await store.list()
    assert.equal(listed[0].id, session.id)
    assert.equal(listed[0].messageCount, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
```

- [ ] **Step 3: Run tests and typecheck**

Run: `cd myagent && npm test && npm run typecheck`

Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add myagent/src/services/session/sessionStore.ts myagent/test/session.test.ts
git commit -m "feat: add resumable session store"
```

---

### Task 4: Prompt Composer and Context Budget

**Files:**
- Create: `myagent/src/prompts/system.ts`
- Create: `myagent/src/prompts/harness.ts`
- Create: `myagent/src/prompts/coding.ts`
- Create: `myagent/src/prompts/safety.ts`
- Create: `myagent/src/prompts/outputFormat.ts`
- Create: `myagent/src/prompts/index.ts`
- Create: `myagent/src/harness/contextBudget.ts`
- Create: `myagent/src/harness/contextBuilder.ts`
- Create: `myagent/test/context.test.ts`

- [ ] **Step 1: Write prompt modules**

Write `myagent/src/prompts/system.ts`:

```ts
export const systemPrompt = `You are MyAgent, a CLI coding agent.
You help with software engineering tasks in the current working directory.
Do not claim a file changed unless a tool confirms it.
Use tools when repository state matters.
When uncertain, ask or inspect.
Do not invent command output, file paths, or API behavior.
Tool results override assumptions.`
```

Write `myagent/src/prompts/harness.ts`:

```ts
export const harnessPrompt = `Harness rules:
- The model cannot directly modify files; it must use tools.
- Existing files must be read before editing.
- Tool calls should be minimal and relevant.
- After a tool result, continue from confirmed facts only.`
```

Write `myagent/src/prompts/coding.ts`:

```ts
export const codingPrompt = `Coding rules:
- Prefer small, focused changes.
- Match surrounding code style.
- Do not add broad abstractions for one-off behavior.
- Validate changes when practical.`
```

Write `myagent/src/prompts/safety.ts`:

```ts
export const safetyPrompt = `Safety rules:
- Never delete files without explicit user approval.
- Dangerous commands default to denial unless the user explicitly approves them.
- Ask before overwriting existing files.
- Do not bypass permission checks.`
```

Write `myagent/src/prompts/outputFormat.ts`:

```ts
export const outputFormatPrompt = `Default output formats:
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
- Suggested next step`
```

Write `myagent/src/prompts/index.ts`:

```ts
import { systemPrompt } from './system.js'
import { harnessPrompt } from './harness.js'
import { codingPrompt } from './coding.js'
import { safetyPrompt } from './safety.js'
import { outputFormatPrompt } from './outputFormat.js'

export function composeBasePrompt(extraBlocks: string[] = []): string {
  return [
    systemPrompt,
    harnessPrompt,
    codingPrompt,
    safetyPrompt,
    outputFormatPrompt,
    ...extraBlocks.filter(Boolean)
  ].join('\n\n')
}
```

- [ ] **Step 2: Implement context budget**

Write `myagent/src/harness/contextBudget.ts`:

```ts
import { ChatMessage } from './types.js'

export interface ContextBudgetResult {
  messages: ChatMessage[]
  tokenEstimate: number
  strategy: 'full' | 'trim-old-tool-results' | 'summary-plus-recent' | 'needs-compact'
}

export class ContextBudgetManager {
  constructor(private readonly maxTokens = 200_000) {}

  estimateText(text: string): number {
    return Math.ceil(text.length / 4)
  }

  estimateMessages(messages: ChatMessage[]): number {
    return messages.reduce((total, message) => total + this.estimateText(message.content), 0)
  }

  select(messages: ChatMessage[], summary = ''): ContextBudgetResult {
    const tokenEstimate = this.estimateMessages(messages) + this.estimateText(summary)
    const ratio = tokenEstimate / this.maxTokens
    if (ratio < 0.7) return { messages, tokenEstimate, strategy: 'full' }
    if (ratio < 0.85) return { messages: messages.slice(-80), tokenEstimate, strategy: 'trim-old-tool-results' }
    if (ratio < 0.95) return { messages: messages.slice(-40), tokenEstimate, strategy: 'summary-plus-recent' }
    return { messages: messages.slice(-20), tokenEstimate, strategy: 'needs-compact' }
  }
}
```

- [ ] **Step 3: Implement context builder**

Write `myagent/src/harness/contextBuilder.ts`:

```ts
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { composeBasePrompt } from '../prompts/index.js'
import { ChatMessage, SessionRecord, Tool } from './types.js'
import { ContextBudgetManager } from './contextBudget.js'

export interface BuildContextInput {
  cwd: string
  records: SessionRecord[]
  tools: Tool[]
  activeSkills: string[]
  summary: string
}

export interface BuiltContext {
  system: string
  messages: ChatMessage[]
  tokenEstimate: number
  strategy: string
}

export class ContextBuilder {
  constructor(private readonly budget = new ContextBudgetManager()) {}

  async build(input: BuildContextInput): Promise<BuiltContext> {
    const projectContext = await this.readProjectContext(input.cwd)
    const toolContext = this.renderToolDefinitions(input.tools)
    const skillContext = input.activeSkills.length > 0 ? `Active skills:\n${input.activeSkills.join('\n\n')}` : ''
    const system = composeBasePrompt([projectContext, toolContext, skillContext])
    const messages = input.records
      .filter((record): record is SessionRecord & { type: 'message' } => record.type === 'message')
      .map(record => ({
        id: record.id,
        role: record.role,
        content: record.content,
        createdAt: record.createdAt,
        model: record.model
      }))
    const selected = this.budget.select(messages, input.summary)
    return {
      system,
      messages: selected.messages,
      tokenEstimate: selected.tokenEstimate,
      strategy: selected.strategy
    }
  }

  private async readProjectContext(cwd: string): Promise<string> {
    const candidates = ['MYAGENT.md', 'CLAUDE.md', 'AGENTS.md']
    const blocks: string[] = []
    for (const candidate of candidates) {
      try {
        const content = await readFile(path.join(cwd, candidate), 'utf8')
        blocks.push(`${candidate}:\n${content}`)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    return blocks.length > 0 ? `Project context:\n${blocks.join('\n\n')}` : ''
  }

  private renderToolDefinitions(tools: Tool[]): string {
    return `Available tools:\n${tools.map(tool => `- ${tool.name} (${tool.riskLevel}): ${tool.description}`).join('\n')}`
  }
}
```

- [ ] **Step 4: Write context tests**

Write `myagent/test/context.test.ts`:

```ts
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import { ContextBudgetManager } from '../src/harness/contextBudget.js'
import { ContextBuilder } from '../src/harness/contextBuilder.js'

test('context budget keeps small sessions in full', () => {
  const budget = new ContextBudgetManager(1000)
  const result = budget.select([{ id: '1', role: 'user', content: 'hello', createdAt: 'now' }])
  assert.equal(result.strategy, 'full')
  assert.equal(result.messages.length, 1)
})

test('context builder includes project context and tools', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-context-'))
  try {
    await writeFile(path.join(dir, 'MYAGENT.md'), 'Use project instructions.', 'utf8')
    const builder = new ContextBuilder()
    const context = await builder.build({
      cwd: dir,
      records: [{ type: 'message', id: 'm1', role: 'user', content: 'hello', createdAt: 'now' }],
      tools: [{ name: 'grep', description: 'Search files', inputSchema: {}, riskLevel: 'safe', execute: async () => ({ ok: true, content: '' }) }],
      activeSkills: ['Skill content'],
      summary: ''
    })
    assert.match(context.system, /MYAGENT.md/)
    assert.match(context.system, /grep/)
    assert.match(context.system, /Skill content/)
    assert.equal(context.messages.length, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
```

- [ ] **Step 5: Run tests and typecheck**

Run: `cd myagent && npm test && npm run typecheck`

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add myagent/src/prompts myagent/src/harness/contextBudget.ts myagent/src/harness/contextBuilder.ts myagent/test/context.test.ts
git commit -m "feat: add prompt and context management"
```

---

### Task 5: Built-In File and Search Tools

**Files:**
- Create: `myagent/src/tools/grep.ts`
- Create: `myagent/src/tools/readFile.ts`
- Create: `myagent/src/tools/writeFile.ts`
- Create: `myagent/src/tools/editFile.ts`
- Create: `myagent/src/tools/deleteFile.ts`
- Create: `myagent/src/tools/index.ts`
- Create: `myagent/test/tools.test.ts`

- [ ] **Step 1: Implement grep tool**

Write `myagent/src/tools/grep.ts`:

```ts
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import fg from 'fast-glob'
import { Tool } from '../harness/types.js'

interface GrepInput {
  pattern: string
  path?: string
  glob?: string
  caseInsensitive?: boolean
  headLimit?: number
}

export const grepTool: Tool = {
  name: 'grep',
  description: 'Search text files for a regular expression pattern.',
  inputSchema: {},
  riskLevel: 'safe',
  async execute(input, context) {
    const options = input as GrepInput
    const root = path.resolve(context.cwd, options.path ?? '.')
    const entries = await fg(options.glob ?? '**/*', { cwd: root, onlyFiles: true, dot: false })
    const flags = options.caseInsensitive ? 'i' : ''
    const regex = new RegExp(options.pattern, flags)
    const limit = options.headLimit ?? 50
    const matches: string[] = []
    for (const entry of entries) {
      if (matches.length >= limit) break
      const filePath = path.join(root, entry)
      let raw: string
      try {
        raw = await readFile(filePath, 'utf8')
      } catch {
        continue
      }
      const lines = raw.split('\n')
      lines.forEach((line, index) => {
        if (matches.length < limit && regex.test(line)) matches.push(`${path.relative(context.cwd, filePath)}:${index + 1}: ${line}`)
      })
    }
    return { ok: true, content: matches.join('\n') || 'No matches found.' }
  }
}
```

- [ ] **Step 2: Implement read/write/edit/delete tools**

Write `myagent/src/tools/readFile.ts`:

```ts
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { Tool } from '../harness/types.js'

export const readFileTool: Tool = {
  name: 'readFile',
  description: 'Read a UTF-8 text file from the current project.',
  inputSchema: {},
  riskLevel: 'safe',
  async execute(input, context) {
    const { filePath } = input as { filePath: string }
    const absolute = path.resolve(context.cwd, filePath)
    const content = await readFile(absolute, 'utf8')
    context.readFiles.add(absolute)
    return { ok: true, content }
  }
}
```

Write `myagent/src/tools/writeFile.ts`:

```ts
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Tool } from '../harness/types.js'

export const writeFileTool: Tool = {
  name: 'writeFile',
  description: 'Write a UTF-8 text file. Existing-file overwrites require confirmation from the harness.',
  inputSchema: {},
  riskLevel: 'confirm',
  async execute(input, context) {
    const { filePath, content } = input as { filePath: string; content: string }
    const absolute = path.resolve(context.cwd, filePath)
    await mkdir(path.dirname(absolute), { recursive: true })
    await writeFile(absolute, content, 'utf8')
    return { ok: true, content: `Wrote ${filePath}` }
  }
}
```

Write `myagent/src/tools/editFile.ts`:

```ts
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Tool } from '../harness/types.js'

export const editFileTool: Tool = {
  name: 'editFile',
  description: 'Replace an exact string in an existing UTF-8 text file.',
  inputSchema: {},
  riskLevel: 'confirm',
  async execute(input, context) {
    const { filePath, oldString, newString } = input as { filePath: string; oldString: string; newString: string }
    const absolute = path.resolve(context.cwd, filePath)
    if (!context.readFiles.has(absolute)) return { ok: false, content: `Refusing to edit ${filePath}: file must be read first.` }
    const original = await readFile(absolute, 'utf8')
    const occurrences = original.split(oldString).length - 1
    if (occurrences !== 1) return { ok: false, content: `Expected exactly one match for oldString, found ${occurrences}.` }
    await writeFile(absolute, original.replace(oldString, newString), 'utf8')
    return { ok: true, content: `Edited ${filePath}` }
  }
}
```

Write `myagent/src/tools/deleteFile.ts`:

```ts
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { Tool } from '../harness/types.js'

export const deleteFileTool: Tool = {
  name: 'deleteFile',
  description: 'Delete a file. This always requires explicit user approval.',
  inputSchema: {},
  riskLevel: 'dangerous',
  async execute(input, context) {
    const { filePath } = input as { filePath: string }
    await rm(path.resolve(context.cwd, filePath), { force: false })
    return { ok: true, content: `Deleted ${filePath}` }
  }
}
```

- [ ] **Step 3: Export tools**

Write `myagent/src/tools/index.ts`:

```ts
import { Tool } from '../harness/types.js'
import { grepTool } from './grep.js'
import { readFileTool } from './readFile.js'
import { writeFileTool } from './writeFile.js'
import { editFileTool } from './editFile.js'
import { deleteFileTool } from './deleteFile.js'

export function getBuiltinTools(): Tool[] {
  return [grepTool, readFileTool, writeFileTool, editFileTool, deleteFileTool]
}
```

- [ ] **Step 4: Write tool tests**

Write `myagent/test/tools.test.ts`:

```ts
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import { grepTool } from '../src/tools/grep.js'
import { readFileTool } from '../src/tools/readFile.js'
import { editFileTool } from '../src/tools/editFile.js'

function context(cwd: string) {
  return { cwd, sessionId: 's1', readFiles: new Set<string>() }
}

test('grep finds matching lines', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-tools-'))
  try {
    await writeFile(path.join(dir, 'a.txt'), 'hello\nworld\n', 'utf8')
    const result = await grepTool.execute({ pattern: 'hello', glob: '**/*.txt' }, context(dir))
    assert.equal(result.ok, true)
    assert.match(result.content, /a.txt:1/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('editFile refuses editing before readFile', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-tools-'))
  try {
    await writeFile(path.join(dir, 'a.txt'), 'hello\n', 'utf8')
    const result = await editFileTool.execute({ filePath: 'a.txt', oldString: 'hello', newString: 'hi' }, context(dir))
    assert.equal(result.ok, false)
    assert.match(result.content, /must be read first/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('editFile edits after readFile', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-tools-'))
  try {
    const ctx = context(dir)
    await writeFile(path.join(dir, 'a.txt'), 'hello\n', 'utf8')
    await readFileTool.execute({ filePath: 'a.txt' }, ctx)
    const result = await editFileTool.execute({ filePath: 'a.txt', oldString: 'hello', newString: 'hi' }, ctx)
    assert.equal(result.ok, true)
    assert.equal(await readFile(path.join(dir, 'a.txt'), 'utf8'), 'hi\n')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
```

- [ ] **Step 5: Run tests and typecheck**

Run: `cd myagent && npm test && npm run typecheck`

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add myagent/src/tools myagent/test/tools.test.ts
git commit -m "feat: add builtin myagent tools"
```

---

### Task 6: Permission Gate and Tool Runner

**Files:**
- Create: `myagent/src/harness/permissions.ts`
- Create: `myagent/src/harness/toolRunner.ts`
- Create: `myagent/test/toolRunner.test.ts`

- [ ] **Step 1: Implement permission gate**

Write `myagent/src/harness/permissions.ts`:

```ts
import { RiskLevel, Tool } from './types.js'

export interface PermissionRequest {
  tool: Tool
  input: unknown
  reason: string
}

export type PermissionPrompt = (request: PermissionRequest) => Promise<boolean>

export class PermissionGate {
  constructor(private readonly prompt: PermissionPrompt) {}

  async approve(tool: Tool, input: unknown): Promise<boolean> {
    if (tool.riskLevel === 'safe') return true
    const reason = this.reasonFor(tool.riskLevel)
    return this.prompt({ tool, input, reason })
  }

  private reasonFor(riskLevel: RiskLevel): string {
    if (riskLevel === 'confirm') return 'This action changes local state and requires confirmation.'
    return 'This is a dangerous action and requires explicit confirmation.'
  }
}
```

- [ ] **Step 2: Implement tool runner**

Write `myagent/src/harness/toolRunner.ts`:

```ts
import { randomUUID } from 'node:crypto'
import { PermissionGate } from './permissions.js'
import { Tool, ToolCall, ToolContext, ToolResultRecord, ToolUseRecord } from './types.js'

export interface ToolRunEvents {
  onToolUse(record: ToolUseRecord): Promise<void>
  onToolResult(record: ToolResultRecord): Promise<void>
  onApproval(record: unknown): Promise<void>
}

export class ToolRunner {
  constructor(
    private readonly tools: Tool[],
    private readonly permissionGate: PermissionGate,
    private readonly events: ToolRunEvents
  ) {}

  async run(call: ToolCall, context: ToolContext): Promise<ToolResultRecord> {
    const tool = this.tools.find(tool => tool.name === call.name)
    if (!tool) throw new Error(`Unknown tool: ${call.name}`)
    const toolUse: ToolUseRecord = {
      id: call.id,
      type: 'tool_use',
      tool: tool.name,
      input: call.input,
      riskLevel: tool.riskLevel,
      createdAt: new Date().toISOString()
    }
    await this.events.onToolUse(toolUse)
    const approved = await this.permissionGate.approve(tool, call.input)
    await this.events.onApproval({ tool: tool.name, input: call.input, approved, riskLevel: tool.riskLevel })
    if (!approved) {
      const denied = this.result(call, tool.name, false, `User denied permission for ${tool.name}.`)
      await this.events.onToolResult(denied)
      return denied
    }
    try {
      const result = await tool.execute(call.input, context)
      const record = this.result(call, tool.name, result.ok, result.content)
      await this.events.onToolResult(record)
      return record
    } catch (error) {
      const record = this.result(call, tool.name, false, error instanceof Error ? error.message : String(error))
      await this.events.onToolResult(record)
      return record
    }
  }

  private result(call: ToolCall, tool: string, ok: boolean, content: string): ToolResultRecord {
    return {
      id: randomUUID(),
      type: 'tool_result',
      toolUseId: call.id,
      tool,
      ok,
      content,
      createdAt: new Date().toISOString()
    }
  }
}
```

- [ ] **Step 3: Write tool runner tests**

Write `myagent/test/toolRunner.test.ts`:

```ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { PermissionGate } from '../src/harness/permissions.js'
import { ToolRunner } from '../src/harness/toolRunner.js'
import { Tool } from '../src/harness/types.js'

test('tool runner executes safe tool without prompting', async () => {
  let prompted = false
  const tool: Tool = {
    name: 'safeTool',
    description: 'safe',
    inputSchema: {},
    riskLevel: 'safe',
    execute: async () => ({ ok: true, content: 'done' })
  }
  const results: unknown[] = []
  const runner = new ToolRunner([tool], new PermissionGate(async () => {
    prompted = true
    return true
  }), {
    onToolUse: async record => { results.push(record) },
    onToolResult: async record => { results.push(record) },
    onApproval: async record => { results.push(record) }
  })
  const result = await runner.run({ id: 'call1', name: 'safeTool', input: {} }, { cwd: process.cwd(), sessionId: 's1', readFiles: new Set() })
  assert.equal(prompted, false)
  assert.equal(result.ok, true)
  assert.equal(result.content, 'done')
})

test('tool runner denies dangerous tool when permission is false', async () => {
  const tool: Tool = {
    name: 'deleteFile',
    description: 'delete',
    inputSchema: {},
    riskLevel: 'dangerous',
    execute: async () => ({ ok: true, content: 'deleted' })
  }
  const runner = new ToolRunner([tool], new PermissionGate(async () => false), {
    onToolUse: async () => {},
    onToolResult: async () => {},
    onApproval: async () => {}
  })
  const result = await runner.run({ id: 'call1', name: 'deleteFile', input: { filePath: 'a.txt' } }, { cwd: process.cwd(), sessionId: 's1', readFiles: new Set() })
  assert.equal(result.ok, false)
  assert.match(result.content, /denied/)
})
```

- [ ] **Step 4: Run tests and typecheck**

Run: `cd myagent && npm test && npm run typecheck`

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add myagent/src/harness/permissions.ts myagent/src/harness/toolRunner.ts myagent/test/toolRunner.test.ts
git commit -m "feat: add tool permission runner"
```

---

### Task 7: API Clients and Agent Loop

**Files:**
- Create: `myagent/src/services/api/anthropicProvider.ts`
- Create: `myagent/src/services/api/openAiCompatibleProvider.ts`
- Modify: `myagent/src/services/api/providerRegistry.ts`
- Create: `myagent/src/harness/loop.ts`
- Create: `myagent/test/loop.test.ts`

- [ ] **Step 1: Implement Anthropic provider**

Write `myagent/src/services/api/anthropicProvider.ts`:

```ts
import Anthropic from '@anthropic-ai/sdk'
import { ModelProvider, ModelRequest, ModelResponse } from '../../harness/types.js'
import { ProviderConfig } from '../config/types.js'

export class AnthropicProvider implements ModelProvider {
  constructor(
    public readonly name: string,
    private readonly config: ProviderConfig
  ) {}

  async createMessage(request: ModelRequest): Promise<ModelResponse> {
    const apiKey = process.env[this.config.apiKeyEnv]
    if (!apiKey) throw new Error(`Missing API key environment variable: ${this.config.apiKeyEnv}`)
    const client = new Anthropic({ apiKey, baseURL: this.config.baseURL })
    const response = await client.messages.create({
      model: request.model,
      max_tokens: 4096,
      system: request.system,
      messages: request.messages
        .filter(message => message.role !== 'system')
        .map(message => ({ role: message.role === 'assistant' ? 'assistant' : 'user', content: message.content }))
    })
    const content = response.content.map(block => block.type === 'text' ? block.text : '').join('')
    return { content, toolCalls: [] }
  }
}
```

- [ ] **Step 2: Implement OpenAI-compatible provider**

Write `myagent/src/services/api/openAiCompatibleProvider.ts`:

```ts
import OpenAI from 'openai'
import { ModelProvider, ModelRequest, ModelResponse } from '../../harness/types.js'
import { ProviderConfig } from '../config/types.js'

export class OpenAiCompatibleProvider implements ModelProvider {
  constructor(
    public readonly name: string,
    private readonly config: ProviderConfig
  ) {}

  async createMessage(request: ModelRequest): Promise<ModelResponse> {
    const apiKey = process.env[this.config.apiKeyEnv]
    if (!apiKey) throw new Error(`Missing API key environment variable: ${this.config.apiKeyEnv}`)
    const client = new OpenAI({ apiKey, baseURL: this.config.baseURL, defaultHeaders: this.config.headers })
    const response = await client.chat.completions.create({
      model: request.model,
      messages: [
        { role: 'system', content: request.system },
        ...request.messages.map(message => ({ role: message.role === 'assistant' ? 'assistant' as const : 'user' as const, content: message.content }))
      ]
    })
    return { content: response.choices[0]?.message.content ?? '', toolCalls: [] }
  }
}
```

- [ ] **Step 3: Replace provider registry skeleton**

Replace `myagent/src/services/api/providerRegistry.ts` with:

```ts
import { ModelProvider } from '../../harness/types.js'
import { MyAgentConfig } from '../config/types.js'
import { AnthropicProvider } from './anthropicProvider.js'
import { OpenAiCompatibleProvider } from './openAiCompatibleProvider.js'

export class ProviderRegistry {
  constructor(private readonly config: MyAgentConfig) {}

  getActiveProvider(): ModelProvider {
    const providerConfig = this.config.providers[this.config.defaultProvider]
    if (!providerConfig) throw new Error(`Unknown provider: ${this.config.defaultProvider}`)
    if (providerConfig.type === 'anthropic') return new AnthropicProvider(this.config.defaultProvider, providerConfig)
    return new OpenAiCompatibleProvider(this.config.defaultProvider, providerConfig)
  }

  listModels(): string[] {
    return Object.entries(this.config.providers).flatMap(([providerName, provider]) =>
      provider.models.map(model => `${providerName}/${model}`)
    )
  }

  setActive(providerName: string, model: string): MyAgentConfig {
    const provider = this.config.providers[providerName]
    if (!provider) throw new Error(`Unknown provider: ${providerName}`)
    if (!provider.models.includes(model)) throw new Error(`Unknown model for ${providerName}: ${model}`)
    return {
      ...this.config,
      defaultProvider: providerName,
      defaultModel: model
    }
  }
}
```

- [ ] **Step 4: Implement agent loop**

Write `myagent/src/harness/loop.ts`:

```ts
import { randomUUID } from 'node:crypto'
import { ContextBuilder } from './contextBuilder.js'
import { ToolRunner } from './toolRunner.js'
import { ChatMessage, ModelProvider, SessionRecord, Tool, ToolContext } from './types.js'

export interface AgentLoopOptions {
  provider: ModelProvider
  model: string
  tools: Tool[]
  contextBuilder: ContextBuilder
  toolRunner: ToolRunner
  toolContext: ToolContext
  loadRecords(): Promise<SessionRecord[]>
  appendRecord(record: SessionRecord): Promise<void>
  getSummary(): string
}

export class AgentLoop {
  constructor(private readonly options: AgentLoopOptions) {}

  async run(userInput: string): Promise<string> {
    const userMessage: ChatMessage & { type: 'message' } = {
      type: 'message',
      id: randomUUID(),
      role: 'user',
      content: userInput,
      createdAt: new Date().toISOString()
    }
    await this.options.appendRecord(userMessage)
    for (let iteration = 0; iteration < 8; iteration++) {
      const records = await this.options.loadRecords()
      const built = await this.options.contextBuilder.build({
        cwd: this.options.toolContext.cwd,
        records,
        tools: this.options.tools,
        activeSkills: [],
        summary: this.options.getSummary()
      })
      const response = await this.options.provider.createMessage({
        system: built.system,
        messages: built.messages,
        tools: this.options.tools,
        model: this.options.model
      })
      if (response.toolCalls.length === 0) {
        const assistantMessage: ChatMessage & { type: 'message' } = {
          type: 'message',
          id: randomUUID(),
          role: 'assistant',
          content: response.content,
          createdAt: new Date().toISOString(),
          model: this.options.model
        }
        await this.options.appendRecord(assistantMessage)
        return response.content
      }
      for (const toolCall of response.toolCalls) {
        await this.options.toolRunner.run(toolCall, this.options.toolContext)
      }
    }
    throw new Error('Agent loop exceeded maximum tool iterations')
  }
}
```

- [ ] **Step 5: Write loop test**

Write `myagent/test/loop.test.ts`:

```ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { AgentLoop } from '../src/harness/loop.js'
import { ContextBuilder } from '../src/harness/contextBuilder.js'
import { PermissionGate } from '../src/harness/permissions.js'
import { ToolRunner } from '../src/harness/toolRunner.js'
import { ModelProvider, SessionRecord, Tool } from '../src/harness/types.js'

test('agent loop appends user and assistant messages', async () => {
  const records: SessionRecord[] = []
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage() {
      return { content: 'hello back', toolCalls: [] }
    }
  }
  const tools: Tool[] = []
  const runner = new ToolRunner(tools, new PermissionGate(async () => true), {
    onToolUse: async record => { records.push(record) },
    onToolResult: async record => { records.push(record) },
    onApproval: async () => {}
  })
  const loop = new AgentLoop({
    provider,
    model: 'fake-model',
    tools,
    contextBuilder: new ContextBuilder(),
    toolRunner: runner,
    toolContext: { cwd: process.cwd(), sessionId: 's1', readFiles: new Set() },
    loadRecords: async () => records,
    appendRecord: async record => { records.push(record) },
    getSummary: () => ''
  })
  const response = await loop.run('hello')
  assert.equal(response, 'hello back')
  assert.equal(records.filter(record => record.type === 'message').length, 2)
})
```

- [ ] **Step 6: Run tests and typecheck**

Run: `cd myagent && npm test && npm run typecheck`

Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add myagent/src/services/api myagent/src/harness/loop.ts myagent/test/loop.test.ts
git commit -m "feat: add api providers and agent loop"
```

---

### Task 8: Skills Service

**Files:**
- Create: `myagent/src/services/skills/skillsService.ts`
- Create: `myagent/test/skills.test.ts`

- [ ] **Step 1: Implement skills service**

Write `myagent/src/services/skills/skillsService.ts`:

```ts
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import YAML from 'yaml'
import { getSkillsDir } from '../../utils/paths.js'

export interface SkillDefinition {
  name: string
  description: string
  content: string
}

export class SkillsService {
  constructor(private readonly cwd: string) {}

  async list(): Promise<SkillDefinition[]> {
    const skillsDir = getSkillsDir(this.cwd)
    let entries: string[]
    try {
      entries = await readdir(skillsDir)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const skills: SkillDefinition[] = []
    for (const entry of entries) {
      const filePath = path.join(skillsDir, entry, 'SKILL.md')
      try {
        skills.push(this.parse(await readFile(filePath, 'utf8')))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    return skills
  }

  async use(name: string): Promise<SkillDefinition> {
    const skill = (await this.list()).find(skill => skill.name === name)
    if (!skill) throw new Error(`Unknown skill: ${name}`)
    return skill
  }

  private parse(raw: string): SkillDefinition {
    const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
    if (!match) throw new Error('Skill file must include YAML frontmatter')
    const frontmatter = YAML.parse(match[1]) as { name?: string; description?: string }
    if (!frontmatter.name || !frontmatter.description) throw new Error('Skill frontmatter requires name and description')
    return {
      name: frontmatter.name,
      description: frontmatter.description,
      content: match[2].trim()
    }
  }
}
```

- [ ] **Step 2: Write skills tests**

Write `myagent/test/skills.test.ts`:

```ts
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import { SkillsService } from '../src/services/skills/skillsService.js'

test('skills service lists and loads markdown skills', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-skills-'))
  try {
    const skillDir = path.join(dir, '.myagent', 'skills', 'debugging')
    await mkdir(skillDir, { recursive: true })
    await writeFile(path.join(skillDir, 'SKILL.md'), `---\nname: debugging\ndescription: Use for bugs\n---\n\nInspect first.\n`, 'utf8')
    const service = new SkillsService(dir)
    const skills = await service.list()
    assert.equal(skills.length, 1)
    assert.equal(skills[0].name, 'debugging')
    assert.equal((await service.use('debugging')).content, 'Inspect first.')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
```

- [ ] **Step 3: Run tests and typecheck**

Run: `cd myagent && npm test && npm run typecheck`

Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add myagent/src/services/skills/skillsService.ts myagent/test/skills.test.ts
git commit -m "feat: add local skills service"
```

---

### Task 9: MCP Service and Tool Adapter

**Files:**
- Create: `myagent/src/services/mcp/mcpService.ts`
- Create: `myagent/src/tools/mcpTool.ts`
- Create: `myagent/test/mcp.test.ts`

- [ ] **Step 1: Implement MCP config service**

Write `myagent/src/services/mcp/mcpService.ts`:

```ts
import { getMcpConfigPath } from '../../utils/paths.js'
import { readJsonFile } from '../../utils/json.js'

export interface McpServerConfig {
  command: string
  args?: string[]
  env?: Record<string, string>
}

export interface McpConfig {
  servers: Record<string, McpServerConfig>
}

export class McpService {
  constructor(private readonly cwd: string) {}

  async listServers(): Promise<string[]> {
    const config = await this.loadConfig()
    return Object.keys(config.servers)
  }

  async getServer(name: string): Promise<McpServerConfig> {
    const config = await this.loadConfig()
    const server = config.servers[name]
    if (!server) throw new Error(`Unknown MCP server: ${name}`)
    return server
  }

  private async loadConfig(): Promise<McpConfig> {
    return readJsonFile<McpConfig>(getMcpConfigPath(this.cwd), { servers: {} })
  }
}
```

- [ ] **Step 2: Implement MCP tool placeholder adapter**

Write `myagent/src/tools/mcpTool.ts`:

```ts
import { Tool } from '../harness/types.js'

export function createMcpTool(serverName: string, toolName: string, executeTool: (input: unknown) => Promise<string>): Tool {
  return {
    name: `mcp_${serverName}_${toolName}`,
    description: `Run MCP tool ${toolName} from server ${serverName}.`,
    inputSchema: {},
    riskLevel: 'confirm',
    async execute(input) {
      const content = await executeTool(input)
      return { ok: true, content }
    }
  }
}
```

- [ ] **Step 3: Write MCP tests**

Write `myagent/test/mcp.test.ts`:

```ts
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import { McpService } from '../src/services/mcp/mcpService.js'
import { createMcpTool } from '../src/tools/mcpTool.js'

test('mcp service lists configured servers', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-mcp-'))
  try {
    await mkdir(path.join(dir, '.myagent'), { recursive: true })
    await writeFile(path.join(dir, '.myagent', 'mcp.json'), JSON.stringify({ servers: { filesystem: { command: 'npx', args: ['server'] } } }), 'utf8')
    const service = new McpService(dir)
    assert.deepEqual(await service.listServers(), ['filesystem'])
    assert.equal((await service.getServer('filesystem')).command, 'npx')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('mcp tool adapter wraps executor as confirm-risk tool', async () => {
  const tool = createMcpTool('server', 'echo', async input => JSON.stringify(input))
  assert.equal(tool.name, 'mcp_server_echo')
  assert.equal(tool.riskLevel, 'confirm')
  const result = await tool.execute({ ok: true }, { cwd: process.cwd(), sessionId: 's1', readFiles: new Set() })
  assert.equal(result.content, '{"ok":true}')
})
```

- [ ] **Step 4: Run tests and typecheck**

Run: `cd myagent && npm test && npm run typecheck`

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add myagent/src/services/mcp/mcpService.ts myagent/src/tools/mcpTool.ts myagent/test/mcp.test.ts
git commit -m "feat: add mcp config and tool adapter"
```

---

### Task 10: Init Command

**Files:**
- Create: `myagent/src/commands/init.ts`
- Create: `myagent/test/initCommand.test.ts`

- [ ] **Step 1: Implement init command generator**

Write `myagent/src/commands/init.ts`:

```ts
import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

export interface InitOptions {
  overwrite?: boolean
}

export async function generateMyAgentMd(cwd: string, options: InitOptions = {}): Promise<string> {
  const target = path.join(cwd, 'MYAGENT.md')
  if (!options.overwrite) {
    try {
      await stat(target)
      throw new Error('MYAGENT.md already exists. Choose merge, overwrite, or cancel.')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  const packageJson = await readOptional(path.join(cwd, 'package.json'))
  const readme = await readFirst(cwd, ['README.md', 'readme.md'])
  const tsconfig = await readOptional(path.join(cwd, 'tsconfig.json'))
  const entries = await readdir(cwd)
  const content = `# MYAGENT.md

## Project Overview

${readme ? firstParagraph(readme) : 'No README detected. Update this section with the project purpose.'}

## Development Commands

${packageJson ? renderScripts(packageJson) : '- Add project commands here.'}

## Architecture

Top-level entries:

${entries.slice(0, 30).map(entry => `- ${entry}`).join('\n')}

## Code Conventions

- Match the style used in nearby files.
- Prefer small, focused changes.

## Testing / Validation

${tsconfig ? '- TypeScript config detected; run the project typecheck command when available.' : '- Add validation commands for this project.'}

## Agent Notes

- Read files before editing them.
- Ask before deleting files or performing sensitive operations.
`
  await writeFile(target, content, 'utf8')
  return target
}

async function readOptional(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw error
  }
}

async function readFirst(cwd: string, names: string[]): Promise<string> {
  for (const name of names) {
    const content = await readOptional(path.join(cwd, name))
    if (content) return content
  }
  return ''
}

function firstParagraph(markdown: string): string {
  return markdown.split(/\n\s*\n/).find(block => block.trim() && !block.trim().startsWith('#'))?.trim() ?? 'README detected, but no summary paragraph was found.'
}

function renderScripts(packageJson: string): string {
  const parsed = JSON.parse(packageJson) as { scripts?: Record<string, string> }
  const scripts = Object.entries(parsed.scripts ?? {})
  if (scripts.length === 0) return '- No package scripts detected.'
  return scripts.map(([name, command]) => `- npm run ${name} — ${command}`).join('\n')
}
```

- [ ] **Step 2: Write init command tests**

Write `myagent/test/initCommand.test.ts`:

```ts
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import { generateMyAgentMd } from '../src/commands/init.js'

test('init command generates MYAGENT.md from project files', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-init-'))
  try {
    await writeFile(path.join(dir, 'README.md'), '# App\n\nA sample app.\n', 'utf8')
    await writeFile(path.join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }), 'utf8')
    const target = await generateMyAgentMd(dir)
    const content = await readFile(target, 'utf8')
    assert.match(content, /A sample app/)
    assert.match(content, /npm run test/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('init command refuses overwrite by default', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-init-'))
  try {
    await writeFile(path.join(dir, 'MYAGENT.md'), 'existing', 'utf8')
    await assert.rejects(() => generateMyAgentMd(dir), /already exists/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
```

- [ ] **Step 3: Run tests and typecheck**

Run: `cd myagent && npm test && npm run typecheck`

Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add myagent/src/commands/init.ts myagent/test/initCommand.test.ts
git commit -m "feat: add myagent init command"
```

---

### Task 11: Commands and REPL

**Files:**
- Create: `myagent/src/commands/index.ts`
- Create: `myagent/src/ui/repl.ts`
- Create: `myagent/src/main.ts`
- Create: `myagent/src/entrypoints/cli.ts`
- Create: `myagent/test/commands.test.ts`

- [ ] **Step 1: Implement command router**

Write `myagent/src/commands/index.ts`:

```ts
import { ConfigService } from '../services/config/configService.js'
import { ProviderRegistry } from '../services/api/providerRegistry.js'
import { SessionStore } from '../services/session/sessionStore.js'
import { SkillsService } from '../services/skills/skillsService.js'
import { McpService } from '../services/mcp/mcpService.js'
import { generateMyAgentMd } from './init.js'

export interface RouterContext {
  cwd: string
  writeLine(message: string): void
  setActiveSkill(content: string): void
}

export class CommandRouter {
  constructor(private readonly context: RouterContext) {}

  async run(input: string): Promise<boolean> {
    if (!input.startsWith('/')) return false
    const [command, ...args] = input.slice(1).trim().split(/\s+/)
    if (command === 'model') return this.model(args)
    if (command === 'session') return this.session(args)
    if (command === 'resume') return this.resume(args)
    if (command === 'skills') return this.skills(args)
    if (command === 'mcp') return this.mcp(args)
    if (command === 'init') return this.init(args)
    if (command === 'exit') return true
    this.context.writeLine(`Unknown command: /${command}`)
    return true
  }

  private async model(args: string[]): Promise<boolean> {
    const service = new ConfigService(this.context.cwd)
    const config = await service.load()
    const registry = new ProviderRegistry(config)
    if (args[0] === 'list') this.context.writeLine(registry.listModels().join('\n'))
    else if (args[0] === 'providers') this.context.writeLine(Object.keys(config.providers).join('\n'))
    else if (args[0] === 'use' && args[1]) {
      const [provider, model] = args[1].split('/')
      await service.save(registry.setActive(provider, model))
      this.context.writeLine(`Using ${provider}/${model}`)
    } else this.context.writeLine(`Current model: ${config.defaultProvider}/${config.defaultModel}`)
    return true
  }

  private async session(args: string[]): Promise<boolean> {
    const store = new SessionStore(this.context.cwd)
    if (args[0] === 'list') {
      const sessions = await store.list()
      this.context.writeLine(sessions.map(session => `${session.id} ${session.title}`).join('\n') || 'No sessions found.')
    } else {
      this.context.writeLine('Session commands: /session list, /session new, /session title <name>')
    }
    return true
  }

  private async resume(args: string[]): Promise<boolean> {
    const store = new SessionStore(this.context.cwd)
    if (args[0]) this.context.writeLine(`Resume requested: ${args[0]}`)
    else this.context.writeLine((await store.list()).map(session => `${session.id} ${session.title}`).join('\n') || 'No sessions found.')
    return true
  }

  private async skills(args: string[]): Promise<boolean> {
    const service = new SkillsService(this.context.cwd)
    if (args[0] === 'list') {
      this.context.writeLine((await service.list()).map(skill => `${skill.name} — ${skill.description}`).join('\n') || 'No skills found.')
    } else if (args[0] === 'use' && args[1]) {
      const skill = await service.use(args[1])
      this.context.setActiveSkill(skill.content)
      this.context.writeLine(`Using skill: ${skill.name}`)
    } else this.context.writeLine('Skills commands: /skills list, /skills use <name>')
    return true
  }

  private async mcp(args: string[]): Promise<boolean> {
    const service = new McpService(this.context.cwd)
    if (args[0] === 'list') this.context.writeLine((await service.listServers()).join('\n') || 'No MCP servers configured.')
    else if (args[0] === 'connect' && args[1]) this.context.writeLine(`MCP connect requested: ${args[1]}`)
    else if (args[0] === 'tools') this.context.writeLine('MCP tools are available after connecting a server.')
    else this.context.writeLine('MCP commands: /mcp list, /mcp connect <name>, /mcp tools')
    return true
  }

  private async init(args: string[]): Promise<boolean> {
    const target = await generateMyAgentMd(this.context.cwd, { overwrite: args.includes('--overwrite') })
    this.context.writeLine(`Wrote ${target}`)
    return true
  }
}
```

- [ ] **Step 2: Implement readline REPL**

Write `myagent/src/ui/repl.ts`:

```ts
import readline from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import { CommandRouter } from '../commands/index.js'
import { AgentLoop } from '../harness/loop.js'

export interface ReplOptions {
  cwd: string
  loop: AgentLoop
}

export async function startRepl(options: ReplOptions): Promise<void> {
  const rl = readline.createInterface({ input, output })
  const activeSkills: string[] = []
  const router = new CommandRouter({
    cwd: options.cwd,
    writeLine: message => output.write(`${message}\n`),
    setActiveSkill: content => { activeSkills.push(content) }
  })
  try {
    for (;;) {
      const line = await rl.question('myagent> ')
      if (line.trim() === '/exit') break
      if (!line.trim()) continue
      const handled = await router.run(line.trim())
      if (handled) continue
      const response = await options.loop.run(line)
      output.write(`${response}\n`)
    }
  } finally {
    rl.close()
  }
}
```

- [ ] **Step 3: Implement main bootstrap**

Write `myagent/src/main.ts`:

```ts
import readline from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import { ConfigService } from './services/config/configService.js'
import { ProviderRegistry } from './services/api/providerRegistry.js'
import { SessionStore } from './services/session/sessionStore.js'
import { ContextBuilder } from './harness/contextBuilder.js'
import { PermissionGate } from './harness/permissions.js'
import { ToolRunner } from './harness/toolRunner.js'
import { AgentLoop } from './harness/loop.js'
import { getBuiltinTools } from './tools/index.js'
import { startRepl } from './ui/repl.js'

export interface MainOptions {
  cwd: string
  newSession?: boolean
  resumeSessionId?: string
}

export async function main(options: MainOptions): Promise<void> {
  const configService = new ConfigService(options.cwd)
  const config = await configService.load()
  const registry = new ProviderRegistry(config)
  const provider = registry.getActiveProvider()
  const sessionStore = new SessionStore(options.cwd)
  const session = options.resumeSessionId
    ? await sessionStore.load(options.resumeSessionId)
    : await chooseSession(options.cwd, sessionStore, config.defaultProvider, config.defaultModel, options.newSession)
  const tools = getBuiltinTools()
  const toolContext = { cwd: options.cwd, sessionId: session.id, readFiles: new Set<string>() }
  const permissionGate = new PermissionGate(async request => {
    const rl = readline.createInterface({ input, output })
    try {
      const answer = await rl.question(`${request.reason}\nTool: ${request.tool.name}\nInput: ${JSON.stringify(request.input)}\nApprove? type yes: `)
      return answer.trim() === 'yes'
    } finally {
      rl.close()
    }
  })
  const runner = new ToolRunner(tools, permissionGate, {
    onToolUse: async record => { await sessionStore.appendRecord(session.id, record) },
    onToolResult: async record => { await sessionStore.appendRecord(session.id, record) },
    onApproval: async record => { await sessionStore.recordApproval(session.id, record) }
  })
  const loop = new AgentLoop({
    provider,
    model: config.defaultModel,
    tools,
    contextBuilder: new ContextBuilder(),
    toolRunner: runner,
    toolContext,
    loadRecords: async () => sessionStore.readRecords(session.id),
    appendRecord: async record => { await sessionStore.appendRecord(session.id, record) },
    getSummary: () => session.contextState.summary
  })
  await startRepl({ cwd: options.cwd, loop })
}

async function chooseSession(cwd: string, store: SessionStore, provider: string, model: string, forceNew = false) {
  if (forceNew || !(await store.hasAnySessions())) return store.create(provider, model)
  const sessions = await store.list()
  const rl = readline.createInterface({ input, output })
  try {
    output.write('Start MyAgent session:\n1. New session\n2. Resume most recent\n3. Choose from history\n')
    const answer = await rl.question('Select 1, 2, or 3: ')
    if (answer.trim() === '2') return store.load(sessions[0].id)
    if (answer.trim() === '3') {
      sessions.forEach((session, index) => output.write(`${index + 1}. ${session.id} ${session.title}\n`))
      const selected = Number(await rl.question('Session number: '))
      return store.load(sessions[selected - 1].id)
    }
    return store.create(provider, model)
  } finally {
    rl.close()
  }
}
```

- [ ] **Step 4: Implement CLI entrypoint**

Write `myagent/src/entrypoints/cli.ts`:

```ts
#!/usr/bin/env node
import { main } from '../main.js'
import { generateMyAgentMd } from '../commands/init.js'

const args = process.argv.slice(2)

if (args.includes('--version')) {
  console.log('0.1.0')
  process.exit(0)
}

if (args[0] === 'init') {
  await generateMyAgentMd(process.cwd(), { overwrite: args.includes('--overwrite') })
  console.log('Wrote MYAGENT.md')
  process.exit(0)
}

const resumeIndex = args.indexOf('--resume')
await main({
  cwd: process.cwd(),
  newSession: args.includes('--new'),
  resumeSessionId: resumeIndex >= 0 ? args[resumeIndex + 1] : undefined
})
```

- [ ] **Step 5: Write command router tests**

Write `myagent/test/commands.test.ts`:

```ts
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import { CommandRouter } from '../src/commands/index.js'

test('command router handles model command', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-commands-'))
  try {
    const lines: string[] = []
    const router = new CommandRouter({ cwd: dir, writeLine: line => lines.push(line), setActiveSkill: () => {} })
    assert.equal(await router.run('/model'), true)
    assert.match(lines[0], /Current model/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
```

- [ ] **Step 6: Run tests and typecheck**

Run: `cd myagent && npm test && npm run typecheck`

Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add myagent/src/commands/index.ts myagent/src/ui/repl.ts myagent/src/main.ts myagent/src/entrypoints/cli.ts myagent/test/commands.test.ts
git commit -m "feat: add myagent repl and commands"
```

---

### Task 12: Final Verification

**Files:**
- Modify only if verification exposes a bug in previous tasks.

- [ ] **Step 1: Run full test suite**

Run: `cd myagent && npm test`

Expected: all tests pass.

- [ ] **Step 2: Run typecheck**

Run: `cd myagent && npm run typecheck`

Expected: no TypeScript errors.

- [ ] **Step 3: Verify version command**

Run: `cd myagent && npm run dev -- --version`

Expected output includes:

```text
0.1.0
```

- [ ] **Step 4: Verify init command in a temporary directory**

Run:

```bash
tmpdir=$(mktemp -d) && printf '{"scripts":{"test":"node --test"}}' > "$tmpdir/package.json" && (cd "$tmpdir" && node --import tsx "C:/Users/Miyano/Documents/code/ClaudeCode/myagent/src/entrypoints/cli.ts" init) && test -f "$tmpdir/MYAGENT.md"
```

Expected: command exits with code 0 and `MYAGENT.md` exists.

- [ ] **Step 5: Verify new session startup reaches model API error cleanly**

Run: `cd myagent && printf 'hello\n/exit\n' | npm run dev -- --new`

Expected: if no API key is configured, the CLI reports the missing API key environment variable rather than crashing with an unrelated error.

- [ ] **Step 6: Commit final fixes if any**

If verification required fixes:

```bash
git add myagent
git commit -m "fix: complete myagent mvp verification"
```

If no fixes were required, do not create an empty commit.

---

## Self-Review

Spec coverage:

- Claude Code-inspired command/tool/service/harness separation: Tasks 1, 4, 6, 7, 11.
- Prompt and context management: Task 4.
- Long-lived resumable sessions and `/resume`: Tasks 3 and 11.
- JSON-configured provider/model switching: Tasks 2, 7, 11.
- Built-in grep/read/edit/write/delete tools: Task 5.
- Sensitive operation confirmation: Task 6 and delete rules in Task 5.
- Init command: Task 10 and CLI wiring in Task 11.
- Skills: Task 8 and command wiring in Task 11.
- MCP: Task 9 and command wiring in Task 11.
- Final verification: Task 12.

Placeholder scan: no TBD/TODO/fill-in placeholders remain. The MCP implementation is intentionally an MVP config/tool adapter rather than full stdio runtime connection; this matches the plan's reduced runnable scope but is the main implementation limitation to revisit if full MCP execution is required in the MVP.

Type consistency: core types are defined in Task 1 and reused consistently by later tasks. Provider registry signatures are updated in Task 7 after the initial skeleton from Task 2.
