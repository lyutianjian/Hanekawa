# 02 — 项目上下文加载 (MYAGENT.md)

> 优先级：P0 | 难度：低 | 影响：项目感知核心

## 现状

`src/harness/contextBuilder.ts` 的 `buildUserContext()` 方法不读取任何项目级指令文件。`MYAGENT.md`、`CLAUDE.md`、`AGENTS.md` 均被忽略。Agent 对项目约定、架构、编码规范一无所知。

## Claude Code 参考

### CLAUDE.md 加载优先级

**文件**: `src/utils/claudemd.ts:1-26`（注释文档）

```
1. Managed memory  — /etc/claude-code/CLAUDE.md（全局所有用户）
2. User memory     — ~/.claude/CLAUDE.md（用户私有全局指令）
3. Project memory  — CLAUDE.md, .claude/CLAUDE.md, .claude/rules/*.md（项目级，提交到仓库）
4. Local memory    — CLAUDE.local.md（项目私有，gitignore）
```

文件按优先级从低到高加载，后加载的内容对模型注意力权重更高。

### 文件发现函数

**文件**: `src/utils/claudemd.ts:790` — `getMemoryFiles()`

从 CWD 向上遍历到根目录，收集：
- Managed 文件（`/etc/claude-code/`）
- User 文件（`~/.claude/`）
- Project 文件（每层目录的 `CLAUDE.md`、`.claude/CLAUDE.md`、`.claude/rules/*.md`）
- Local 文件（`CLAUDE.local.md`）
- 额外目录（`--add-dir`）

### 格式化与注入

**文件**: `src/utils/claudemd.ts:1153` — `getClaudeMds()`

将所有记忆文件格式化为单一字符串，添加指令前缀：
```
Codebase and user instructions are shown below. Be sure to adhere to these instructions.
IMPORTANT: These instructions OVERRIDE any default behavior and you MUST follow them exactly as written.
```

**文件**: `src/context.ts:155` — `getUserContext()`

调用 `getMemoryFiles()` 和 `getClaudeMds()`，缓存结果，注入到每次对话的上下文中。

### @include 指令支持

**文件**: `src/utils/claudemd.ts:618` — `processMemoryFile()`

递归处理 `@include` 指令（最大深度 5），剥离 HTML 注释，解析 frontmatter 中的 glob 条件规则。

## 改进方案

### 1. 创建 MYAGENT.md 加载模块

新建 `src/services/context/projectContext.ts`：

```typescript
import { readFile, access } from 'fs/promises'
import { join, resolve } from 'path'

const CONTEXT_FILES = [
  'MYAGENT.md',
  'CLAUDE.md',
  'AGENTS.md',
]

const LOCAL_FILES = [
  'MYAGENT.local.md',
  'CLAUDE.local.md',
]

export async function discoverContextFiles(cwd: string): Promise<string[]> {
  const found: string[] = []
  let dir = cwd
  while (dir !== resolve(dir, '..')) {
    for (const name of CONTEXT_FILES) {
      const path = join(dir, name)
      if (await exists(path)) found.push(path)
    }
    // .claude/rules/*.md
    const rulesDir = join(dir, '.myagent', 'rules')
    // ... glob scan
    dir = resolve(dir, '..')
  }
  // Local files (highest priority, loaded last)
  for (const name of LOCAL_FILES) {
    const path = join(cwd, name)
    if (await exists(path)) found.push(path)
  }
  return found
}

export async function loadProjectContext(cwd: string): Promise<string> {
  const files = await discoverContextFiles(cwd)
  const contents = await Promise.all(files.map(f => readFile(f, 'utf-8')))
  if (contents.length === 0) return ''
  return [
    'Project instructions are shown below. These instructions OVERRIDE default behavior.',
    ...contents.map((c, i) => `# ${files[i]}\n${c}`),
  ].join('\n\n')
}
```

### 2. 注入到 ContextBuilder

修改 `src/harness/contextBuilder.ts` 的 `buildSystemBlocks()`：

```typescript
private buildSystemBlocks(system: string | undefined, projectContext?: string): string[] {
  const staticSections = [
    DEFAULT_IDENTITY,
    DEFAULT_INSTRUCTIONS,
    projectContext,  // 注入项目上下文
  ].filter((s): s is string => Boolean(s))
  // ...
}
```

### 3. 缓存机制

项目上下文文件在同一会话中不会变化，首次加载后缓存。仅在 `/compact` 或会话恢复时重新加载。

## 涉及的 MyAgent 文件

| 文件 | 改动 |
|------|------|
| `src/services/context/projectContext.ts` | **新建** — 文件发现与加载 |
| `src/harness/contextBuilder.ts` | `buildSystemBlocks()` 接受项目上下文参数 |
| `src/harness/loop.ts` | 初始化时加载项目上下文并传递给 ContextBuilder |
| `src/harness/compact.ts` | 压缩后重新加载项目上下文 |
