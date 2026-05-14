# 11 — 上下文压缩增强

> 优先级：P2 | 难度：中 | 影响：长对话可持续性

## 现状

MyAgent 实现了 LLM 驱动的压缩（`src/harness/compact.ts`）和压缩后恢复（`src/harness/contextBuilder.ts` 的 `buildPostCompactRestoreContext()`）。但只有单一压缩策略，缺少手动触发入口，且 token 估算精度不足。

## Claude Code 参考

### 压缩策略目录

**文件**: `src/services/compact/`

| 文件 | 策略 | 说明 |
|------|------|------|
| `autoCompact.ts` | auto-compact | Token 超阈值自动触发 |
| `compact.ts` | 核心引擎 | `compactConversation()` — LLM 摘要 |
| `microCompact.ts` | micro-compact | 细粒度压缩，保留更多上下文 |
| `sessionMemoryCompact.ts` | session-memory | 按重要性裁剪消息（更新、更轻量） |
| `reactiveCompact.ts` | reactive | API 返回 prompt-too-long 时触发 |
| `snipCompact.ts` | snip | 选择性移除消息（如大工具结果） |
| `snipProjection.ts` | snip 投影 | 预估 snip 节省的 token 数 |
| `postCompactCleanup.ts` | 清理 | 重置缓存、状态 |
| `prompt.ts` | 提示词 | 发送给 LLM 的压缩指令 |
| `grouping.ts` | 分组 | 按 API 轮次分组消息 |

### 自动压缩触发

**文件**: `src/services/compact/autoCompact.ts`

**阈值** (行 72)：
```typescript
threshold = getEffectiveContextWindowSize(model) - 13_000  // AUTOCOMPACT_BUFFER_TOKENS
```

**`autoCompactIfNeeded()`** (行 241)：
1. 检查断路器（`MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3`）
2. 调用 `shouldAutoCompact()` — 检查 token 是否超阈值
3. 先尝试 `trySessionMemoryCompaction()`（更轻量）
4. 失败则 `compactConversation()`（完整压缩）
5. 失败计数器递增

**递归保护**：排除 `session_memory`、`compact`、`marble_origami` 查询源。

### 手动压缩

**文件**: `src/commands/compact/compact.ts`

`/compact` 命令直接调用 `compactConversation()`，支持自定义压缩指令，显示进度 UI。

### 响应式压缩

**文件**: `src/services/compact/reactiveCompact.ts`

当 API 返回 prompt-too-long 错误时触发，作为恢复机制。

### 压缩后清理

**文件**: `src/services/compact/postCompactCleanup.ts`

重置各类缓存和状态，确保压缩后的会话状态一致。

## 改进方案

### 1. 多策略压缩

新建 `src/harness/compact/` 目录：

```
src/harness/compact/
  ├── auto.ts          // 自动压缩（阈值触发）
  ├── manual.ts        // 手动压缩（/compact 命令）
  ├── reactive.ts      // 响应式压缩（API 错误触发）
  ├── snip.ts          // 裁剪压缩（移除大工具结果）
  ├── engine.ts        // 核心 LLM 压缩引擎
  └── prompt.ts        // 压缩提示词
```

### 2. Snip 压缩策略

移除大的工具结果（如完整的文件内容），替换为摘要：

```typescript
function snipLargeToolResults(records: SessionRecord[], maxTokens: number): SessionRecord[] {
  return records.map(record => {
    if (record.type === 'tool_result' && estimateTokens(record.content) > maxTokens) {
      return {
        ...record,
        content: `[Result truncated: ${record.tool} output exceeded ${maxTokens} tokens]`,
      }
    }
    return record
  })
}
```

### 3. Session Memory 压缩

按消息重要性评分裁剪：

```typescript
function sessionMemoryCompact(records: SessionRecord[], targetTokens: number): SessionRecord[] {
  const scored = records.map(r => ({
    record: r,
    score: calculateImportance(r),
  }))
  scored.sort((a, b) => b.score - a.score)

  let tokens = 0
  const kept: SessionRecord[] = []
  for (const { record, score } of scored) {
    const recordTokens = estimateRecordTokens(record)
    if (tokens + recordTokens <= targetTokens || score > IMPORTANCE_THRESHOLD) {
      kept.push(record)
      tokens += recordTokens
    }
  }
  return kept.sort((a, b) => a.createdAt - b.createdAt) // 恢复时间顺序
}
```

### 4. 手动 /compact 命令

集成到斜杠命令系统（见 03-slash-commands.md）：

```typescript
// src/commands/compact.ts
export const compactCommand: CommandDefinition = {
  name: 'compact',
  description: 'Compress conversation context to free up token budget',
  async run(args, context) {
    const summary = await compactConversation(records, { customInstructions: args })
    context.writeLine(`Context compressed. Summary:\n${summary}`)
  },
}
```

### 5. 断路器机制

参考 Claude Code 的 `MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3`：

```typescript
let consecutiveFailures = 0
const MAX_FAILURES = 3

async function autoCompactIfNeeded() {
  if (consecutiveFailures >= MAX_FAILURES) return
  try {
    await compactConversation(records)
    consecutiveFailures = 0
  } catch (error) {
    consecutiveFailures++
  }
}
```

## 涉及的 MyAgent 文件

| 文件 | 改动 |
|------|------|
| `src/harness/compact.ts` | 重构为多策略架构 |
| `src/harness/compact/snip.ts` | **新建** — 裁剪压缩 |
| `src/harness/compact/auto.ts` | **新建** — 自动压缩触发 |
| `src/harness/compact/reactive.ts` | **新建** — 响应式压缩 |
| `src/harness/loop.ts` | 集成自动和响应式压缩 |
| `src/harness/contextBuilder.ts` | 压缩后恢复逻辑优化 |
| `src/prompts/budget.ts` | 更精确的 token 计数（依赖 10-token-estimation） |
