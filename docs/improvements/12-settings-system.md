# 12 — 多级设置系统

> 优先级：P3 | 难度：中 | 影响：配置灵活性

## 现状

`src/config/service.ts` 的 `ConfigService` 读写单一 `.myagent/config.json` 文件。无多级配置合并，无项目级设置覆盖，无设置验证。

## Claude Code 参考

### 设置源优先级

**文件**: `src/utils/settings/constants.ts:7-22`

```typescript
SETTING_SOURCES = [
  'userSettings',      // ~/.claude/settings.json
  'projectSettings',   // <project-root>/.claude/settings.json
  'localSettings',     // <project-root>/.claude/settings.local.json
  'flagSettings',      // --settings CLI flag
  'policySettings',    // managed-settings.json (企业级)
]
```

### 设置文件路径

**文件**: `src/utils/settings/settings.ts:274-307`

| 源 | 路径 | 说明 |
|----|------|------|
| `userSettings` | `~/.claude/settings.json` | 全局用户设置 |
| `projectSettings` | `<project>/.claude/settings.json` | 项目共享设置（提交到仓库） |
| `localSettings` | `<project>/.claude/settings.local.json` | 本地项目设置（gitignore） |
| `policySettings` | `<managed>/managed-settings.json` | 企业托管设置 |

### 设置合并策略

**文件**: `src/utils/settings/settings.ts:645` — `loadSettingsFromDisk()`

使用 `lodash mergeWith` + 自定义策略：
- 数组：**连接并去重**
- 对象：深度合并（后者覆盖前者）
- 标量：后者覆盖前者

合并顺序：plugin < user < project < local < flag < policy

### 设置类型

**文件**: `src/utils/settings/types.ts:42`

```typescript
type SettingsSchema = {
  permissions?: {
    allow?: string[]
    deny?: string[]
    ask?: string[]
    defaultMode?: PermissionMode
    disableBypassPermissionsMode?: boolean
    additionalDirectories?: string[]
  }
  hooks?: {
    PreToolUse?: HookConfig[]
    PostToolUse?: HookConfig[]
    Notification?: HookConfig[]
  }
  sandbox?: SandboxSettings
  environmentVariables?: Record<string, string>
  enabledPlugins?: string[]
  // ...
}
```

### 设置验证

**文件**: `src/utils/settings/validation.ts`

验证规则：
- 权限规则格式（`"ToolName"` 或 `"ToolName(pattern)"`）
- 工具名是否有效
- 路径是否存在
- 环境变量名格式

### 全局配置 vs 设置

Claude Code 区分两种配置：
- **Global config** (`~/.claude.json`)：偏好、信任状态、per-project 状态
- **Settings** (`settings.json`)：权限规则、hooks、沙箱等

## 改进方案

### 1. 设置文件结构

```
~/.myagent/settings.json          # 用户全局设置
<project>/.myagent/settings.json  # 项目共享设置
<project>/.myagent/settings.local.json  # 本地设置（gitignore）
```

### 2. 设置类型定义

新建 `src/config/settings.ts`：

```typescript
interface MyAgentSettings {
  // 权限
  permissions?: {
    allow?: string[]   // ["Glob", "Grep", "Bash(git *)"]
    deny?: string[]
    ask?: string[]
  }
  // MCP 服务器
  mcpServers?: Record<string, {
    transport: 'stdio' | 'sse'
    command?: string
    args?: string[]
    url?: string
  }>
  // 模型
  defaultModel?: string
  // 自动压缩
  autoCompact?: boolean
  autoCompactThreshold?: number
  // 环境变量
  env?: Record<string, string>
}
```

### 3. 多级合并

```typescript
import { mergeWith } from 'lodash-es'

function settingsMerger(objValue: unknown, srcValue: unknown): unknown {
  if (Array.isArray(objValue) && Array.isArray(srcValue)) {
    return [...new Set([...objValue, ...srcValue])]  // 数组去重合并
  }
}

async function loadMergedSettings(cwd: string): Promise<MyAgentSettings> {
  const userSettings = await loadSettingsFile(join(homedir(), '.myagent', 'settings.json'))
  const projectSettings = await loadSettingsFile(join(cwd, '.myagent', 'settings.json'))
  const localSettings = await loadSettingsFile(join(cwd, '.myagent', 'settings.local.json'))

  return mergeWith(
    {},
    userSettings,
    projectSettings,
    localSettings,
    settingsMerger,
  )
}
```

### 4. 设置验证

```typescript
function validateSettings(settings: MyAgentSettings): ValidationResult {
  const errors: string[] = []
  if (settings.permissions?.allow) {
    for (const rule of settings.permissions.allow) {
      if (!isValidPermissionRule(rule)) {
        errors.push(`Invalid permission rule: ${rule}`)
      }
    }
  }
  if (settings.mcpServers) {
    for (const [name, config] of Object.entries(settings.mcpServers)) {
      if (config.transport === 'stdio' && !config.command) {
        errors.push(`MCP server "${name}" with stdio transport requires "command"`)
      }
    }
  }
  return { valid: errors.length === 0, errors }
}
```

### 5. CLI 参数覆盖

```typescript
// --model, --permissions 等 CLI 参数优先级最高
const cliOverrides = parseCliArgs(process.argv)
const finalSettings = mergeWith({}, mergedSettings, cliOverrides, settingsMerger)
```

## 涉及的 MyAgent 文件

| 文件 | 改动 |
|------|------|
| `src/config/settings.ts` | **新建** — 设置类型、加载、合并、验证 |
| `src/config/service.ts` | 重构为多级设置加载 |
| `src/harness/permissions.ts` | 从设置中加载权限规则 |
| `src/harness/loop.ts` | 使用合并后的设置 |
| `src/entrypoints/cli.ts` | 解析 CLI 设置覆盖参数 |
| `src/harness/contextBuilder.ts` | 从设置中读取项目上下文路径 |
