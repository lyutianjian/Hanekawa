# 05 — 权限系统增强

> 优先级：P1 | 难度：中 | 影响：安全与 UX

## 现状

`src/harness/permissions.ts` 实现三级风险门控：`safe`（自动批准）、`confirm`（y/N 提示）、`dangerous`（y/N 提示）。无规则系统、无会话级自动批准、无文件系统级保护。每次非安全操作都需要手动确认，且显示原始 JSON 输入。

## Claude Code 参考

### 权限模式

**文件**: `src/types/permissions.ts`

7 种模式：`default`、`acceptEdits`、`bypassPermissions`、`dontAsk`、`plan`、`auto`、`bubble`

### 权限规则类型

**文件**: `src/types/permissions.ts:75-79`

```typescript
type PermissionRule = {
  source: 'userSettings' | 'projectSettings' | 'localSettings'
        | 'flagSettings' | 'policySettings' | 'cliArg' | 'command' | 'session'
  ruleBehavior: 'allow' | 'deny' | 'ask'
  ruleValue: { toolName: string; ruleContent?: string }
  // ruleContent 示例: "git *" 表示只允许 git 命令
}
```

### 权限决策结果

**文件**: `src/types/permissions.ts:251-266`

```typescript
type PermissionResult = PermissionDecision | {
  behavior: 'passthrough'
  message: string
  suggestions?: PermissionUpdate[]
  blockedPath?: string
}
```

### ToolPermissionContext

**文件**: `src/types/permissions.ts:427-441`

```typescript
type ToolPermissionContext = {
  mode: PermissionMode
  additionalWorkingDirectories: ReadonlyMap<string, AdditionalWorkingDirectory>
  alwaysAllowRules: ToolPermissionRulesBySource
  alwaysDenyRules: ToolPermissionRulesBySource
  alwaysAskRules: ToolPermissionRulesBySource
  isBypassPermissionsModeAvailable: boolean
  shouldAvoidPermissionPrompts?: boolean
}
```

### 权限决策流程

**文件**: `src/utils/permissions/permissions.ts:1158` — `hasPermissionsToUseToolInner()`

```
Step 1a (行 1171): getDenyRuleForTool() → 工具级 deny → deny
Step 1b (行 1184): getAskRuleForTool() → 工具级 ask → ask
Step 1c (行 1210): tool.checkPermissions() → 工具自检
Step 1f (行 1243): 内容级 ask 规则（bypass-immune）
Step 1g (行 1252): 安全检查（.git/, .claude/, shell 配置 — bypass-immune）
Step 2a (行 1268): bypassPermissions 模式检查
Step 2b (行 1284): toolAlwaysAllowedRule() → blanket allow
Step 3 (行 1300): passthrough → ask
```

模式特定转换：
- `dontAsk`: ask → deny
- `auto`: 运行 AI 分类器 `classifyYoloAction()`

### 文件系统权限

**文件**: `src/utils/permissions/filesystem.ts`

```typescript
// 行 57-68: 受保护文件
DANGEROUS_FILES = ['.gitconfig', '.bashrc', '.zshrc', '.mcp.json', '.claude.json', ...]

// 行 74-79: 受保护目录
DANGEROUS_DIRECTORIES = ['.git', '.vscode', '.idea', '.claude']
```

### 规则加载

**文件**: `src/utils/permissions/permissionsLoader.ts:120-145`

```typescript
loadAllPermissionRulesFromDisk() → 按 source 加载所有规则
getPermissionRulesForSource(source) → 从 settings.json 的 permissions.allow/deny/ask 数组转换
```

规则格式：`"ToolName"` 或 `"ToolName(ruleContent)"`，如 `"Bash(git *)"`。

### 危险模式检测

**文件**: `src/utils/permissions/dangerousPatterns.ts` (2.6KB)

检测高风险命令模式，即使在 bypassPermissions 模式下也会提示。

## 改进方案

### 1. 权限规则系统

修改 `src/harness/permissions.ts`，添加规则匹配：

```typescript
interface PermissionRule {
  toolName: string
  contentPattern?: string  // 如 "git *"
  behavior: 'allow' | 'deny'
  source: 'session' | 'config'
}

class PermissionGate {
  private sessionRules: PermissionRule[] = []
  private configRules: PermissionRule[] = []

  check(toolName: string, input: unknown, riskLevel: RiskLevel): 'allow' | 'deny' | 'ask' {
    // 1. 检查 deny 规则
    // 2. 检查 allow 规则
    // 3. 检查文件系统保护
    // 4. 回退到风险级别
  }
}
```

### 2. 会话级 "Always Allow"

在用户批准工具调用时，提供 "always allow for this session" 选项：

```typescript
const answer = await prompt(`${toolName}(${JSON.stringify(input)})\n[y/N/a] `)
if (answer === 'a') {
  this.sessionRules.push({ toolName, behavior: 'allow', source: 'session' })
  return 'allow'
}
```

### 3. 文件系统保护

```typescript
const PROTECTED_PATHS = ['.git', '.myagent', '.env', '.ssh']
const PROTECTED_FILES = ['.gitconfig', '.bashrc', '.zshrc', '.env']

function isProtectedPath(path: string): boolean {
  const normalized = path.replace(/\\/g, '/')
  return PROTECTED_PATHS.some(p => normalized.includes(`/${p}/`))
    || PROTECTED_FILES.some(f => normalized.endsWith(`/${f}`))
}
```

### 4. 持久化权限设置

在 `.myagent/config.json` 中添加 `permissions` 字段：

```json
{
  "permissions": {
    "allow": ["Glob", "Grep", "ReadFile"],
    "deny": ["Bash(rm -rf *)"],
    "ask": ["Bash"]
  }
}
```

### 5. 改进权限提示 UX

显示友好的工具调用描述而非原始 JSON：

```
bash: git status
Allow? [y/N/a(lways)]
```

## 涉及的 MyAgent 文件

| 文件 | 改动 |
|------|------|
| `src/harness/permissions.ts` | 重构为规则引擎，添加会话级 allow |
| `src/harness/types.ts` | 添加 `PermissionRule` 类型 |
| `src/config/service.ts` | 添加 `permissions` 配置字段 |
| `src/tools/bash.ts` | 特殊的 bash 命令权限检查 |
| `src/entrypoints/cli.ts` | 改进权限提示 UX |
