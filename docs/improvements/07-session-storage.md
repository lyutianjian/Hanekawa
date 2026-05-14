# 07 — 会话存储优化

> 优先级：P1 | 难度：低 | 影响：性能与可靠性

## 现状

`src/sessions/service.ts` 的 `SessionStore` 使用单 JSON 文件存储整个会话。每次 `appendRecord()` 都执行完整文件读取 → JSON.parse → 追加记录 → JSON.stringify → 完整重写。大对话（数百条记录）时性能显著下降，且写入过程中崩溃会丢失整个会话。

## Claude Code 参考

### 会话文件路径

**文件**: `src/utils/sessionStorage.ts:198-202`

```typescript
getProjectsDir() → ~/.claude/projects/
getTranscriptPath() → ~/.claude/projects/<sanitized-project-path>/<session-uuid>.jsonl
```

子智能体转录：`~/.claude/projects/<project>/<session>/subagents/agent-<id>.jsonl`

### 追加写入模式

**文件**: `src/utils/sessionStorage.ts:2572`

```typescript
function appendEntryToFile(fullPath: string, entry: Record<string, unknown>): void {
  const line = jsonStringify(entry) + '\n'
  try {
    fs.appendFileSync(fullPath, line, { mode: 0o600 })
  } catch {
    fs.mkdirSync(dirname(fullPath), { mode: 0o700 })
    fs.appendFileSync(fullPath, line, { mode: 0o600 })
  }
}
```

关键设计：
- `appendFileSync` — 原子追加，不重写整个文件
- `0o600` — 仅 owner 读写
- 目录不存在时自动创建（`0o700`）
- 每条记录一行 JSON（JSONL 格式）

### LogWriter 类

**文件**: `src/utils/sessionStorage.ts:768+`

```typescript
class LogWriter {
  logUser(entry)   → appendEntryToFile(this.sessionFile, { type: 'user', ... })
  logAssistant(entry) → appendEntryToFile(this.sessionFile, { type: 'assistant', ... })
  logSystem(entry) → appendEntryToFile(this.sessionFile, { type: 'system', ... })
  // ...
}
```

### 会话发现

**文件**: `src/utils/listSessionsImpl.ts:79`

无独立索引文件。通过扫描目录中的 `.jsonl` 文件发现会话，从文件 stat（mtime、size）和 head/tail 读取提取元数据。

```typescript
parseSessionInfoFromLite(file: LiteSessionFile): SessionInfo
// 读取 JSONL 文件的前几行和后几行，提取 summary、title、first prompt 等
```

## 改进方案

### 1. 切换到 JSONL 追加格式

修改 `src/sessions/service.ts`：

```typescript
// 写入：追加一行
appendRecord(sessionId: string, record: SessionRecord): void {
  const filePath = this.getSessionPath(sessionId)
  const line = JSON.stringify(record) + '\n'
  fs.appendFileSync(filePath, line, { mode: 0o600 })
  // 同时更新索引缓存
  this.updateIndex(sessionId, record)
}

// 读取：逐行解析
loadRecords(sessionId: string): SessionRecord[] {
  const filePath = this.getSessionPath(sessionId)
  const content = fs.readFileSync(filePath, 'utf-8')
  return content.split('\n')
    .filter(line => line.trim())
    .map(line => JSON.parse(line) as SessionRecord)
}
```

### 2. 元数据索引

维护轻量索引文件 `.myagent/sessions/index.json`：

```typescript
interface SessionIndex {
  [sessionId: string]: {
    title: string
    createdAt: string
    lastActiveAt: string
    recordCount: number
    totalTokens: number
  }
}
```

追加记录时同步更新索引（内存中缓存，定期刷盘）。

### 3. 文件权限

参考 Claude Code，使用 `0o600` 权限（仅 owner 读写）：

```typescript
fs.appendFileSync(filePath, line, { mode: 0o600 })
```

### 4. 迁移兼容

保留对旧格式（单 JSON）的读取支持，首次加载旧会话时自动转换为 JSONL。

## 涉及的 MyAgent 文件

| 文件 | 改动 |
|------|------|
| `src/sessions/service.ts` | 重写为 JSONL 追加格式，添加索引管理 |
| `src/harness/loop.ts` | 使用新的 appendRecord 接口 |
| `src/entrypoints/cli.ts` | `list` 和 `resume` 命令适配新格式 |
