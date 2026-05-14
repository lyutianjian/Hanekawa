# 03 — 斜杠命令系统

> 优先级：P0 | 难度：中 | 影响：交互体验核心

## 现状

`src/entrypoints/cli.ts` 的 REPL 只处理 `/exit` 命令。用户无法在会话中切换模型、手动压缩上下文、查看成本统计或管理会话。

## Claude Code 参考

### 命令注册表

**文件**: `src/commands.ts:258` — `COMMANDS()` 函数

返回所有内置命令的数组。80+ 个命令，每个是独立目录。

**文件**: `src/commands.ts:476` — `getCommands()` 入口

合并来源：内置命令、技能目录、插件、打包技能、工作流、MCP 服务器。

### 三种命令类型

**文件**: `src/types/command.ts`

| 类型 | 行号 | 说明 | 示例 |
|------|------|------|------|
| `PromptCommand` | 25 | 展开为模型输入 | `/review` |
| `LocalCommand` | 74 | 本地执行返回文本 | `/cost` |
| `LocalJSXCommand` | 144 | 渲染 Ink UI | `/model` |

### 命令实现模式

每个命令是独立目录，导出 `Command` 对象，使用懒加载：

**`/compact`** — `src/commands/compact/index.ts`：
```typescript
const compact = {
  type: 'local',
  name: 'compact',
  description: 'Clear conversation history but keep a summary...',
  isEnabled: () => !isEnvTruthy(process.env.DISABLE_COMPACT),
  supportsNonInteractive: true,
  argumentHint: '<optional custom summarization instructions>',
  load: () => import('./compact.js'),
} satisfies Command
```

**`/cost`** — `src/commands/cost/index.ts`：
```typescript
const cost = {
  type: 'local',
  name: 'cost',
  description: 'Show the total cost and duration of the current session',
  supportsNonInteractive: true,
  load: () => import('./cost.js'),
} satisfies Command
```

**`/model`** — `src/commands/model/index.ts`：
```typescript
{
  type: 'local',
  name: 'model',
  description: `Set the AI model (currently ${renderModelName(getMainLoopModel())})`,
  argumentHint: '[model]',
  load: () => import('./model.js'),
}
```

### 命令分发流程

```
用户输入 "/compact custom instructions"
  → 解析命令名 "compact" 和参数 "custom instructions"
  → 查找命令注册表
  → 如果 type === 'local': 调用 load() 获取模块，执行 call(args, context)
  → 如果 type === 'prompt': 调用 getPromptForCommand() 获取内容块，注入到模型输入
```

## 改进方案

### 1. 命令类型定义

新建 `src/commands/types.ts`：

```typescript
export interface CommandDefinition {
  name: string
  description: string
  argumentHint?: string
  isEnabled?: () => boolean
  run: (args: string, context: CommandRunContext) => Promise<string | void>
}

export interface CommandRunContext {
  cwd: string
  writeLine: (msg: string) => void
  // 可访问会话状态、provider 等
}
```

### 2. 实现核心命令

新建 `src/commands/` 目录，每个命令一个文件：

| 命令 | 文件 | 功能 |
|------|------|------|
| `/help` | `src/commands/help.ts` | 列出所有可用命令 |
| `/compact` | `src/commands/compact.ts` | 手动触发上下文压缩 |
| `/cost` | `src/commands/cost.ts` | 显示 token 用量和成本 |
| `/model` | `src/commands/model.ts` | 切换模型（列出可用模型或直接设置） |
| `/session` | `src/commands/session.ts` | 会话管理（新建、列出、恢复） |
| `/skills` | `src/commands/skills.ts` | 列出已加载技能 |
| `/clear` | `src/commands/clear.ts` | 清屏 |
| `/config` | `src/commands/config.ts` | 查看/修改配置 |

### 3. REPL 命令分发

修改 `src/entrypoints/cli.ts` 的 REPL 循环：

```typescript
// 在发送到 LLM 之前检查斜杠命令
if (input.startsWith('/')) {
  const [cmdName, ...argsParts] = input.slice(1).split(' ')
  const command = commandRegistry.get(cmdName)
  if (command) {
    const result = await command.run(argsParts.join(' '), commandContext)
    if (result) console.log(result)
    continue // 不发送到 LLM
  }
  console.log(`Unknown command: /${cmdName}. Type /help for available commands.`)
  continue
}
```

### 4. 命令注册表

新建 `src/commands/registry.ts`：

```typescript
const commands = new Map<string, CommandDefinition>()

export function registerCommand(def: CommandDefinition) {
  commands.set(def.name, def)
}

export function getCommand(name: string): CommandDefinition | undefined {
  return commands.get(name)
}

export function listCommands(): CommandDefinition[] {
  return [...commands.values()].filter(c => c.isEnabled?.() ?? true)
}
```

## 涉及的 MyAgent 文件

| 文件 | 改动 |
|------|------|
| `src/commands/types.ts` | **新建** — 命令类型定义 |
| `src/commands/registry.ts` | **新建** — 命令注册表 |
| `src/commands/*.ts` | **新建** — 各命令实现 |
| `src/entrypoints/cli.ts` | REPL 循环添加命令分发逻辑 |
| `src/harness/contextBuilder.ts` | 可选：将可用命令列表注入 system prompt |
