# Claude Code 源码架构参考文档

> 本文档基于 Claude Code CLI 源码分析，旨在为 MyAgent 的功能完善提供架构参考和改进建议。

---

## 目录

1. [架构总览](#1-架构总览)
2. [启动路径](#2-启动路径)
3. [核心注册表](#3-核心注册表)
4. [全局状态管理](#4-全局状态管理)
5. [工具系统](#5-工具系统)
6. [命令系统](#6-命令系统)
7. [权限系统](#7-权限系统)
8. [MCP 集成](#8-mcp-集成)
9. [上下文管理与压缩](#9-上下文管理与压缩)
10. [消息与会话流](#10-消息与会话流)
11. [多智能体协调](#11-多智能体协调)
12. [会话持久化](#12-会话持久化)
13. [MyAgent 对比矩阵](#13-myagent-对比矩阵)
14. [MyAgent 改进建议](#14-myagent-改进建议)

---

## 1. 架构总览

Claude Code 是一个基于 React/Ink 的 CLI 编码智能体，核心设计原则：

- **懒加载一切** — 命令、工具、插件、技能均通过动态 `import()` / `require()` 按需加载，启动路径只加载最少模块
- **模块级单例状态** — `bootstrap/state.ts` 使用纯 getter/setter 函数，无类、无 store，避免循环依赖
- **构建时死代码消除** — 通过 `feature()` 标志和 `process.env` 检查，在构建时移除整个模块
- **Tool 作为富接口** — 每个工具拥有自己的渲染、权限、验证、提示词和进度展示
- **分层权限** — 多来源规则 + 多模式 + AI 分类器自动审批 + 交互式回退

### 关键文件路径

| 职责 | 路径 |
|------|------|
| CLI 入口 | `src/entrypoints/cli.tsx` |
| 主会话启动 | `src/main.tsx` |
| REPL 启动器 | `src/replLauncher.tsx` |
| 工具注册表 | `src/tools.ts` |
| 命令注册表 | `src/commands.ts` |
| 全局状态 | `src/bootstrap/state.ts` |
| Tool 接口定义 | `src/Tool.ts` |
| 消息类型 | `src/types/message.ts` |
| 权限类型 | `src/types/permissions.ts` |

---

## 2. 启动路径

```
cli.tsx (fast-path checks)
  ├── --version → 直接输出
  ├── --daemon-worker → 动态加载 daemon 模块
  ├── --bg → 动态加载 background-session
  ├── remote-control → 动态加载 bridge
  └── 默认 → import('../main.js')
                ├── Commander 参数解析
                ├── 配置加载
                ├── Analytics 初始化
                └── replLauncher.tsx
                      ├── App.tsx (Ink 根组件)
                      └── REPL.tsx (会话主循环)
```

**设计要点**：`cli.tsx` 对每个特殊模式只动态导入所需模块，普通启动路径的 import 链最短。MyAgent 的 `src/entrypoints/cli.ts` 已采用类似模式（`new`/`list`/`resume`/`help` 分发），可进一步优化懒加载粒度。

---

## 3. 核心注册表

### 3.1 工具注册表 (`src/tools.ts`)

```typescript
// 核心函数
getAllBaseTools(): Tool[]           // 返回所有内置工具
getTools(permissionContext): Tool[] // 按权限过滤
assembleToolPool(permissionContext, mcpTools): Tool[] // 合并内置+MCP，去重，排序
```

工具按条件加载：
- **始终加载**：AgentTool, BashTool, FileReadTool, FileEditTool, FileWriteTool, GlobTool, GrepTool, WebFetchTool, WebSearchTool, TodoWriteTool, SkillTool, AskUserQuestionTool
- **Feature 门控**：LSPTool (`ENABLE_LSP_TOOL`)、WorktreeTool、CronTool、MonitorTool
- **用户类型门控**：REPLTool、ConfigTool (`USER_TYPE === 'ant'`)

### 3.2 命令注册表 (`src/commands.ts`)

三种命令类型：

| 类型 | 说明 | 示例 |
|------|------|------|
| `PromptCommand` | 展开为模型输入 | `/review`, `/compact` |
| `LocalCommand` | 本地执行返回文本 | `/cost`, `/diff` |
| `LocalJSXCommand` | 渲染 Ink UI | `/permissions`, `/model` |

命令来源：内置 (`COMMANDS()`)、技能目录、插件、打包技能、工作流、MCP 服务器。

---

## 4. 全局状态管理

`src/bootstrap/state.ts` 使用模块级单例模式：

```typescript
type State = {
  // 会话标识
  sessionId: SessionId
  originalCwd: string
  projectRoot: string
  cwd: string

  // 成本/用量追踪
  totalCostUSD: number
  totalAPIDuration: number
  modelUsage: { [modelName: string]: ModelUsage }
  totalLinesAdded: number
  totalLinesRemoved: number
  turnToolCount: number

  // 模型状态
  mainLoopModelOverride: ModelSetting | undefined
  initialMainLoopModel: ModelSetting
  modelStrings: ModelStrings | null

  // UI 模式
  isInteractive: boolean
  sessionBypassPermissionsMode: boolean

  // 遥测
  meter: Meter | null
  sessionCounter: AttributedCounter | null
  // ... 更多计数器

  // 智能体协调
  agentColorMap: Map<AgentId, AgentColorName>
  registeredHooks: RegisteredHookMatcher[]
}
```

**设计约束**：注释明确标注 "DO NOT ADD MORE STATE HERE"。这是一个 DAG 叶节点 — 不导入任何它也被导入的模块，防止循环依赖。

**MyAgent 参考**：MyAgent 目前没有类似的全局状态模块，会话状态分散在 `AgentLoop`、`ToolContext` 和 `SessionStore` 中。可考虑引入轻量级全局状态。

---

## 5. 工具系统

### 5.1 Tool 接口 (`src/Tool.ts`, 793 行)

```typescript
type Tool<Input, Output, P> = {
  readonly name: string
  aliases?: string[]

  // 核心方法
  call(args, context, canUseTool, parentMessage, onProgress?): Promise<ToolResult<Output>>
  description(input, options): Promise<string>
  readonly inputSchema: Input  // Zod schema

  // 权限与验证
  checkPermissions(input, context): Promise<PermissionResult>
  validateInput?(input, context): Promise<ValidationResult>
  isReadOnly(input): boolean
  isDestructive?(input): boolean
  isConcurrencySafe(input): boolean
  isEnabled(): boolean

  // 渲染
  renderToolUseMessage(input, options): React.ReactNode
  renderToolResultMessage?(content, progressMessages, options): React.ReactNode
  userFacingName(input): string

  // 输出映射
  mapToolResultToToolResultBlockParam(content, toolUseID): ToolResultBlockParam

  // 提示词
  prompt(options): Promise<string>

  // 元数据
  maxResultSizeChars: number
  shouldDefer?: boolean
  alwaysLoad?: boolean
  isMcp?: boolean
}
```

### 5.2 buildTool() 工厂

```typescript
// 安全默认值（fail-closed）
buildTool({
  name, inputSchema, outputSchema,
  call(), checkPermissions(), validateInput(),
  // 默认值：
  isEnabled: () => true
  isConcurrencySafe: () => false  // 假设不安全
  isReadOnly: () => false         // 假设有写操作
  isDestructive: () => false
  checkPermissions: () => ({ behavior: 'allow' })
})
```

### 5.3 ToolResult 类型

```typescript
type ToolResult<T> = {
  data: T
  newMessages?: Message[]        // 附加消息
  contextModifier?: unknown       // 上下文修改器
  mcpMeta?: unknown               // MCP 元数据
}
```

### 5.4 完整工具列表 (40+)

| 工具 | 目录 | 说明 |
|------|------|------|
| AgentTool | `tools/AgentTool/` | 子智能体生成 |
| AskUserQuestionTool | `tools/AskUserQuestionTool/` | 向用户提问 |
| BashTool | `tools/BashTool/` | Shell 命令执行（最复杂，40K+ token） |
| BriefTool | `tools/BriefTool/` | 简要模式 |
| ConfigTool | `tools/ConfigTool/` | 配置管理（ant-only） |
| EnterPlanModeTool | `tools/EnterPlanModeTool/` | 进入计划模式 |
| EnterWorktreeTool | `tools/EnterWorktreeTool/` | 进入工作树 |
| ExitPlanModeTool | `tools/ExitPlanModeTool/` | 退出计划模式 |
| ExitWorktreeTool | `tools/ExitWorktreeTool/` | 退出工作树 |
| FileEditTool | `tools/FileEditTool/` | 文件编辑（原子读-改-写） |
| FileReadTool | `tools/FileReadTool/` | 文件读取（文本/图片/PDF/Notebook） |
| FileWriteTool | `tools/FileWriteTool/` | 文件写入 |
| GlobTool | `tools/GlobTool/` | 文件模式匹配 |
| GrepTool | `tools/GrepTool/` | 正则搜索（基于 ripgrep） |
| LSPTool | `tools/LSPTool/` | LSP 诊断 |
| ListMcpResourcesTool | `tools/ListMcpResourcesTool/` | 列出 MCP 资源 |
| MCPTool | `tools/MCPTool/` | MCP 工具包装器 |
| McpAuthTool | `tools/McpAuthTool/` | MCP 认证 |
| NotebookEditTool | `tools/NotebookEditTool/` | Jupyter Notebook 编辑 |
| PowerShellTool | `tools/PowerShellTool/` | PowerShell 支持 |
| REPLTool | `tools/REPLTool/` | REPL 交互（ant-only） |
| ReadMcpResourceTool | `tools/ReadMcpResourceTool/` | 读取 MCP 资源 |
| ScheduleCronTool | `tools/ScheduleCronTool/` | 定时任务（Create/Delete/List） |
| SendMessageTool | `tools/SendMessageTool/` | 向子智能体发送消息 |
| SkillTool | `tools/SkillTool/` | 技能调用 |
| SnipTool | `tools/SnipTool/` | 上下文裁剪 |
| TaskCreateTool | `tools/TaskCreateTool/` | 创建任务 |
| TaskGetTool | `tools/TaskGetTool/` | 获取任务详情 |
| TaskListTool | `tools/TaskListTool/` | 列出任务 |
| TaskOutputTool | `tools/TaskOutputTool/` | 获取后台任务输出 |
| TaskStopTool | `tools/TaskStopTool/` | 停止后台任务 |
| TaskUpdateTool | `tools/TaskUpdateTool/` | 更新任务状态 |
| ToolSearchTool | `tools/ToolSearchTool/` | 工具搜索 |
| WebBrowserTool | `tools/WebBrowserTool/` | 浏览器自动化 |
| WebFetchTool | `tools/WebFetchTool/` | URL 抓取（HTML→Markdown） |
| WebSearchTool | `tools/WebSearchTool/` | Web 搜索（Anthropic 内置） |

### 5.5 关键工具实现模式

**BashTool** — 最复杂的工具：
- `bashPermissions.ts` — 专门的权限检查
- `bashSecurity.ts` — 命令安全分析
- `shouldUseSandbox.ts` — 沙箱决策
- `commandSemantics.ts` — 命令语义解读
- 支持 sed 解析、路径验证、只读验证、破坏性命令警告
- 后台任务管理

**FileEditTool** — 原子编辑：
- 验证文件已被读取（`readFileState`）
- 检查文件修改时间戳
- 原子读-改-写操作
- 通知 LSP 服务器

**FileReadTool** — 多格式支持：
- 文本文件（UTF-8）
- 图片（压缩/缩放）
- PDF（页面提取）
- Jupyter Notebook
- 去重逻辑：未变更文件返回 stub

---

## 6. 命令系统

### 命令结构

```typescript
type Command =
  | PromptCommand    // getPromptForCommand() → content blocks
  | LocalCommand     // load() → execute locally → text
  | LocalJSXCommand  // load() → render Ink component
```

每个命令是独立目录（如 `src/commands/clear/`），导出 `Command` 对象。

命令可具有：
- `hooks` — 调用时注册的钩子
- `context` — `inline` vs `fork` 执行模式
- `effort` — 推理努力级别
- `paths` — 条件可见性
- `availability` — 限制到特定认证上下文（`claude-ai`、`console`）

---

## 7. 权限系统

### 7.1 权限模式

| 模式 | 说明 |
|------|------|
| `default` | 正常提示 |
| `acceptEdits` | 自动接受文件编辑 |
| `bypassPermissions` | 跳过所有权限检查 |
| `dontAsk` | 自动拒绝（不提示） |
| `plan` | 计划模式（只读） |
| `auto` | AI 分类器自动审批 |
| `bubble` | 向父智能体冒泡权限 |

### 7.2 权限规则

```typescript
type PermissionRule = {
  source: 'localSettings' | 'userSettings' | 'projectSettings'
        | 'policySettings' | 'flagSettings' | 'enterprise'
        | 'claudeai' | 'managed' | 'cliArg' | 'command' | 'session'
  ruleBehavior: 'allow' | 'deny' | 'ask'
  ruleValue: { toolName: string; ruleContent?: string }
  // ruleContent 示例: "git *" 表示只允许 git 命令
}
```

### 7.3 权限决策流程

```
hasPermissionsToUseTool()
  ├── Step 1a: 检查工具级 deny 规则
  ├── Step 1b: 检查工具级 ask 规则
  ├── Step 1c: 调用 tool.checkPermissions()
  ├── Step 1d: 工具被拒绝 → deny
  ├── Step 1e: 需要用户交互 → ask
  ├── Step 1f: 内容级 ask 规则（即使 bypass 模式也尊重）
  ├── Step 1g: 安全检查（.git/, .claude/, shell 配置等，bypass-immune）
  ├── Step 2a: 检查 bypassPermissions 模式
  ├── Step 2b: 检查 always-allowed 规则
  └── Step 3: passthrough → ask

模式特定转换：
  dontAsk: ask → deny
  auto: 运行 AI 分类器 (classifyYoloAction)
  headless: 运行 PermissionRequest hooks → auto-deny
```

### 7.4 文件系统权限

`checkReadPermissionForTool()` 和 `checkWritePermissionForTool()`：
- 按路径模式检查 deny/ask/allow 规则
- 验证危险文件（`.gitconfig`, `.bashrc`, `.mcp.json` 等）
- 验证危险目录（`.git`, `.vscode`, `.idea`, `.claude`）
- UNC 路径安全（防止 NTLM 凭据泄露）
- 支持 `ignore` 库的 gitignore 风格模式匹配

### 7.5 Auto 模式分类器

`yoloClassifier.ts` 实现基于 AI 的权限分类器：
- 分析对话上下文判断工具操作是否安全
- 两阶段流水线，带成本追踪
- 连续拒绝和总拒绝次数限制
- 分类器不可用时可 fail-closed 或 fail-open

**MyAgent 参考**：MyAgent 的 `PermissionGate` 只有三级（safe/confirm/dangerous），缺少规则系统、会话级自动批准和文件系统级权限检查。

---

## 8. MCP 集成

### 8.1 传输类型

```typescript
type McpServerConfig =
  | { transport: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }
  | { transport: 'sse'; url: string }
  | { transport: 'sse-ide'; url: string }
  | { transport: 'http'; url: string }
  | { transport: 'ws'; url: string }
  | { transport: 'ws-ide'; url: string }
  | { transport: 'sdk' }
  | { transport: 'claudeai-proxy' }
```

### 8.2 服务器状态

```typescript
type MCPServerConnection =
  | ConnectedMCPServer   // client, name, capabilities, config, cleanup()
  | FailedMCPServer      // error 信息
  | NeedsAuthMCPServer   // 需要 OAuth 认证
  | PendingMCPServer     // 连接中
  | DisabledMCPServer    // 已禁用
```

### 8.3 配置作用域

`local` → `user` → `project` → `dynamic` → `enterprise` → `claudeai` → `managed`

配置来源：各级 `settings.json`、插件清单、Claude.ai 代理配置。

### 8.4 MCP 工具包装

MCP 工具通过 `MCPTool` 包装，命名规范化为 `mcp__<server>__<tool>`，支持进度报告、输出截断和二进制内容持久化。

### 8.5 连接管理

- 使用 `@modelcontextprotocol/sdk` Client 类
- 支持 OAuth 认证
- 自动重连（指数退避，最多 5 次）
- 通知订阅：`ToolListChanged`、`ResourceListChanged`、`PromptListChanged`

**MyAgent 参考**：MyAgent 的 `@modelcontextprotocol/sdk` 依赖已声明但零实现。这是最大的功能缺口之一。

---

## 9. 上下文管理与压缩

### 9.1 压缩类型

| 类型 | 文件 | 说明 |
|------|------|------|
| auto-compact | `services/compact/autoCompact.ts` | 自动压缩（token 超阈值时触发） |
| micro-compact | `services/compact/microCompact.ts` | 微压缩（更细粒度） |
| snip-compact | `services/compact/snipCompact.ts` | 裁剪压缩 |
| reactive-compact | `services/compact/reactiveCompact.ts` | 响应式压缩 |
| session-memory-compact | `services/compact/sessionMemoryCompact.ts` | 会话记忆压缩 |

### 9.2 Token 预算管理

- 消息选择：在预算内选择要包含的历史消息
- 工具结果截断：超过 token 限制的工具结果被截断
- 总工具结果限制：不超过上下文窗口的 50%

### 9.3 Prompt 缓存

**Anthropic**：
- 标记最后一个 system block 和最后一个 user message 为 ephemeral 缓存
- 支持 1 小时 TTL（通过环境变量）
- 在 static/dynamic 边界处分割 system prompt

**OpenAI**：
- 基于 SHA256(model+system+tools) 构建缓存键

### 9.4 压缩后恢复

压缩后自动恢复：
- 最近读取的文件（最多 5 个，每个 5K token，总计 50K token）
- 已调用的技能（无限数量，每个 5K token，总计 25K token）

**MyAgent 参考**：MyAgent 已实现 LLM 驱动的压缩和压缩后恢复，但 token 估算使用简单的字符启发式（ASCII 4字符/token，CJK 2字符/token），精度较低。

---

## 10. 消息与会话流

### 10.1 消息类型

```typescript
type Message =
  | UserMessage         // { type: 'user', message: { content: string | ContentBlock[] } }
  | AssistantMessage    // { type: 'assistant', message: { content: unknown } }
  | ProgressMessage     // { type: 'progress', progress?: unknown }
  | SystemMessage       // { type: 'system', subtype?, level?, message? }
  | AttachmentMessage   // { type: 'attachment', path? }
  | HookResultMessage   // { type: 'hook_result' }
  | ToolUseSummaryMessage // { type: 'tool_use_summary' }
  | TombstoneMessage    // { type: 'tombstone' }
  | GroupedToolUseMessage // { type: 'grouped_tool_use' }

// 所有消息继承 MessageBase
type MessageBase = {
  uuid: UUID
  parentUuid?: UUID
  timestamp: number
  isMeta?: boolean
  isVirtual?: boolean
  toolUseResult?: unknown
  isCompactSummary?: boolean
}
```

SystemMessage 子类型：`local_command`、`bridge_status`、`turn_duration`、`thinking`、`memory_saved`、`compact_boundary`、`permission_retry` 等。

### 10.2 消息流

```
用户输入 → handlePromptSubmit()
  → useCommandQueue (可能排队)
  → query() (src/services/api/claude.ts)
    → 流式 API 调用
    → handleMessageFromStream()
    → canUseTool() → 权限检查 → 工具执行
    → 结果追加到消息
    → 循环直到模型停止
  → 消息持久化到 .jsonl 文件
```

### 10.3 会话持久化

Claude Code 使用 JSONL 追加格式：
- 每条消息一行 JSON
- 追加写入，不重写整个文件
- 支持大对话的高效写入

**MyAgent 参考**：MyAgent 使用单 JSON 文件存储整个会话，每次 `appendRecord` 都完整读取和重写。大对话时性能会下降。

---

## 11. 多智能体协调

### 11.1 协调器模式

`src/coordinator/coordinatorMode.ts` 定义协调器编排模式：

- 通过环境变量 `CLAUDE_CODE_COORDINATOR_MODE` 启用
- 协调器角色：编排者，通过 Agent tool 生成 worker
- 通信方式：`<task-notification>` XML 消息
- 工作流：Research（并行 worker）→ Synthesis（协调器）→ Implementation（worker）→ Verification（worker）

### 11.2 AgentTool (`src/tools/AgentTool/runAgent.ts`, 974 行)

智能体生成流程：

1. 创建 `agentId`（UUID）
2. 解析智能体模型 (`getAgentModel()`)
3. 创建子智能体上下文 (`createSubagentContext()`)
   - 同步：共享父级 `setAppState`、`abortController`
   - 异步：独立 `AbortController`，`shouldAvoidPermissionPrompts: true`
4. 设置权限模式
5. 解析工具集 (`resolveAgentTools()`)
6. 初始化智能体专属 MCP 服务器
7. 调用 `query()` 生成器循环
8. 清理：MCP 服务器、会话钩子、文件状态缓存

### 11.3 内置智能体定义

| 智能体 | 文件 | 说明 |
|--------|------|------|
| exploreAgent | `built-in/exploreAgent.ts` | 快速只读搜索 |
| generalPurposeAgent | `built-in/generalPurposeAgent.ts` | 通用智能体 |
| planAgent | `built-in/planAgent.ts` | 架构规划 |
| verificationAgent | `built-in/verificationAgent.ts` | 验证智能体 |
| claudeCodeGuideAgent | `built-in/claudeCodeGuideAgent.ts` | Claude Code 指南 |

**MyAgent 参考**：MyAgent 目前没有子智能体支持。这是高级功能，可作为远期目标。

---

## 12. 会话持久化

### Claude Code 格式

- **JSONL 追加写入** — 每条记录一行 JSON
- **会话文件**：`.claude/sessions/<session-id>.jsonl`
- **会话索引**：快速列出和搜索
- **会话恢复**：按 ID 或前缀匹配

### MyAgent 格式

- **单 JSON 文件** — 整个会话在一个 JSON 对象中
- **会话文件**：`.myagent/sessions/<session-id>.json`
- **每次追加都完整重写**

---

## 13. MyAgent 对比矩阵

| 方面 | Claude Code | MyAgent | 差距 |
|------|------------|---------|------|
| **UI 框架** | Ink (React for CLI) | 纯 readline | 中 |
| **Provider 支持** | Anthropic 专用 | Anthropic + OpenAI 兼容 | MyAgent 优势 |
| **Prompt 缓存** | Anthropic 原生 | Anthropic 原生 + OpenAI 缓存键 | MyAgent 优势 |
| **MCP 支持** | 完整 stdio+SSE+WS | 依赖已声明但零实现 | **高差距** |
| **工具数量** | 40+ | 11 | **高差距** |
| **技能系统** | 文件驱动，Skill tool | 文件驱动，Skill tool | 持平 |
| **会话存储** | JSONL 追加 | 单 JSON 重写 | 中 |
| **上下文压缩** | 多种策略（auto/micro/snip/reactive） | LLM 摘要 | 中 |
| **权限系统** | 多层规则 + AI 分类器 | 三级（safe/confirm/dangerous） | **高差距** |
| **Hooks** | 预/后工具钩子 | 无 | 中 |
| **子智能体** | AgentTool + 协调器 | 无 | 低（远期） |
| **Git 集成** | 原生工具 | 仅通过 bash | 低 |
| **流式显示** | 实时 token 流 | 无（等待完整响应） | **高差距** |
| **成本追踪** | 是 | 是（可配置定价） | 持平 |
| **并行工具执行** | 支持 | 顺序执行 | 中 |
| **Abort 处理** | 传递到工具 | 不传递 | 中 |
| **项目上下文** | CLAUDE.md 自动加载 | 未实现 | **高差距** |
| **斜杠命令** | 丰富（/model, /compact, /session...） | 仅 /exit | **高差距** |
| **非交互模式** | --print 管道模式 | 无 | 低 |

---

## 14. MyAgent 改进建议

按优先级排序，P0 为最高优先级。

### P0 — 核心体验

#### 14.1 流式输出显示

**现状**：Anthropic provider 使用 `stream()` 但丢弃事件，等待 `finalMessage()`。用户看到 "Thinking..." 然后完整响应一次性出现。

**改进**：
- `src/config/providers.ts` 的 `AnthropicProvider.createMessage()` 中，监听 `stream` 事件并逐 token 输出
- 对 OpenAI provider 同样启用 `stream: true`
- REPL 中实现渐进式渲染

**参考**：Claude Code 的 `src/services/api/claude.ts` 使用 `BetaMessageStreamParams` 和流式事件处理。

#### 14.2 项目上下文加载 (MYAGENT.md)

**现状**：`ContextBuilder.buildUserContext()` 不读取 `MYAGENT.md`/`CLAUDE.md`/`AGENTS.md`。

**改进**：
- 在 `src/harness/contextBuilder.ts` 的 `buildUserContext()` 中添加文件扫描逻辑
- 按优先级加载：`MYAGENT.md` > `CLAUDE.md` > `AGENTS.md`
- 从项目根目录向上搜索
- 注入到 system prompt 的动态部分

**参考**：Claude Code 在 `src/utils/settings/` 中实现多级配置加载。

#### 14.3 斜杠命令系统

**现状**：REPL 只处理 `/exit`。

**改进**：实现以下命令：
- `/model` — 切换模型
- `/compact` — 手动触发压缩
- `/session` — 会话管理
- `/skills` — 列出/管理技能
- `/mcp` — MCP 服务器管理
- `/cost` — 显示成本统计
- `/help` — 帮助信息
- `/clear` — 清屏

**参考**：Claude Code 的 `src/commands/` 目录结构，每种命令类型独立目录。

### P1 — 功能完善

#### 14.4 MCP 集成

**现状**：`@modelcontextprotocol/sdk` 依赖已声明但零实现。

**改进**：
1. 创建 `src/services/mcp/` 模块
2. 实现 MCP 客户端连接管理（至少 stdio 传输）
3. 实现 MCP 工具发现和包装
4. 实现 MCP 配置加载（`.myagent/config.json` 中的 `mcpServers` 字段）
5. 将 MCP 工具合并到工具池

**参考**：Claude Code 的 `src/services/mcp/client.ts`（连接生命周期）、`types.ts`（传输类型）、`config.ts`（配置作用域）。

#### 14.5 权限系统增强

**现状**：三级（safe/confirm/dangerous），每次非安全操作都需 y/N。

**改进**：
1. 添加会话级 "always allow" 选项
2. 添加规则系统（按工具名 + 内容模式匹配）
3. 添加持久化权限设置（`.myagent/permissions.json`）
4. 文件系统级权限检查（保护 `.git/`、`.myagent/`、shell 配置等）

**参考**：Claude Code 的 `src/utils/permissions/` 目录（20+ 文件）。

#### 14.6 并行工具执行

**现状**：`loop.ts` 中工具调用顺序执行。

**改进**：
```typescript
// 当前：顺序执行
for (const toolCall of toolCalls) {
  await toolRunner.run(toolCall, ...)
}

// 改进：并行执行独立工具
const results = await Promise.all(
  toolCalls.map(tc => toolRunner.run(tc, ...))
)
```

**参考**：Claude Code 的 `Tool.isConcurrencySafe()` 方法标记工具是否可并发执行。

#### 14.7 会话存储优化

**现状**：单 JSON 文件，每次追加都完整重写。

**改进**：
1. 切换到 JSONL 追加格式
2. 或至少实现增量写入（追加记录到文件末尾）
3. 加载时流式解析而非全量读取

**参考**：Claude Code 的 `.claude/sessions/*.jsonl` 格式。

### P2 — 体验优化

#### 14.8 Abort 信号传递

**现状**：`ToolRunner.run()` 接受 `AbortSignal` 但不传递给 `tool.execute()`。

**改进**：
- 将 signal 传递到工具执行函数
- BashTool 特别需要：中断长时间运行的命令
- 在 `ToolContext` 中添加 `abortSignal` 字段

#### 14.9 OpenAI Provider 完善

**现状**：`OpenAIProvider` 缺少 retry 和 streaming。

**改进**：
- 添加 `withRetry()` 包装（参考 `AnthropicProvider`）
- 启用 `stream: true` 并处理流式事件
- 添加超时降级机制

#### 14.10 Token 估算精度

**现状**：`countTextTokens()` 使用字符启发式。

**改进**：
- 集成 `tiktoken` 或 `@anthropic-ai/tokenizer` 进行精确计数
- 或至少对代码内容调整估算系数

#### 14.11 工具 Abort 处理

**现状**：信号不传递到工具，长时间运行的工具无法中断。

**改进**：
- 在 `ToolContext` 中添加 `abortSignal?: AbortSignal`
- BashTool 使用 `signal` 终止子进程
- 其他工具在等待时检查 `signal.aborted`

### P3 — 远期目标

#### 14.12 子智能体支持

- 实现 AgentTool，支持生成子智能体
- 子智能体可拥有独立工具集和权限
- 同步/异步两种模式

#### 14.13 Ink TUI 替代 readline

- 使用 React/Ink 构建富终端 UI
- 支持 Markdown 渲染、代码高亮、Diff 显示
- 虚拟滚动支持长对话

#### 14.14 Hooks 系统

- 预工具钩子（执行前验证）
- 后工具钩子（结果后处理）
- 用户可定义自定义钩子

#### 14.15 Web 搜索工具

- 集成搜索 API（如 Brave Search、SerpAPI）
- 或使用 Anthropic 内置 web_search 工具类型

---

## 附录 A：Claude Code 工具实现模式速查

每个工具遵循统一模式：

```
src/tools/<ToolName>/
  ├── <ToolName>.ts      // 主实现（call, checkPermissions, validateInput）
  ├── prompt.ts          // 工具提示词
  ├── UI.tsx             // Ink 渲染组件
  ├── permissions.ts     // 专属权限逻辑（可选）
  └── utils.ts           // 工具特定工具函数（可选）
```

工具创建模板：
```typescript
import { buildTool } from '../../Tool.js'
import { z } from 'zod/v4'

export const MyTool = buildTool({
  name: 'my_tool',
  inputSchema: lazySchema(() => z.strictObject({
    param: z.string().describe('参数说明'),
  })),
  outputSchema: lazySchema(() => z.strictObject({
    result: z.string(),
  })),
  isReadOnly: () => true,
  isConcurrencySafe: () => true,

  async call(input, context) {
    // 实现逻辑
    return { data: { result: '...' } }
  },

  async checkPermissions(input, context) {
    return { behavior: 'allow' }
  },
})
```

## 附录 B：MyAgent 现有工具清单

| 工具 | 风险级别 | 说明 |
|------|---------|------|
| `grep` | safe | 正则搜索 |
| `glob` | safe | 文件模式匹配 |
| `bash` | dangerous | Shell 命令 |
| `readFile` | safe | 文件读取 |
| `writeFile` | confirm | 文件写入 |
| `editFile` | confirm | 字符串替换编辑 |
| `deleteFile` | dangerous | 文件删除 |
| `TaskCreate` | safe | 创建任务 |
| `TaskUpdate` | safe | 更新任务 |
| `TaskList` | safe | 列出任务 |
| `TaskGet` | safe | 获取任务详情 |
| `webSearch` | safe | **占位符，未实现** |
| `skillTool` | safe | 技能调用 |

## 附录 C：MyAgent 已知问题清单

1. **会话存储效率**：单 JSON 完整重写，大对话时慢
2. **无流式显示**：等待完整响应才输出
3. **死代码**：`src/cli.ts` 未使用
4. **缺少项目上下文**：不读取 MYAGENT.md/CLAUDE.md
5. **权限 UX 简陋**：无 allow-listing，无会话级自动批准
6. **Token 估算粗糙**：字符启发式不精确
7. **webSearch 占位符**：返回错误
8. **MCP 幽灵功能**：依赖已声明但零代码
9. **工具顺序执行**：独立工具未并行
10. **Abort 不传递**：工具无法被中断
11. **OpenAI 缺 retry**：瞬时错误会失败
12. **OpenAI 缺 streaming**：无渐进输出
13. **无 /compact 命令**：自动压缩已实现但无手动触发
14. **技能上下文膨胀**：每个技能的名称/描述每轮都出现
15. **Task 工具内存级**：不跨会话持久化
