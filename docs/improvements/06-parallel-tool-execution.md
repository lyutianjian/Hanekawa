# 06 — 并行工具执行

> 优先级：P1 | 难度：低 | 影响：性能

## 现状

`src/harness/loop.ts` 中工具调用顺序执行：

```typescript
for (const toolCall of toolCalls) {
  const result = await toolRunner.run(toolCall, signal)
  // ...
}
```

当模型返回多个独立工具调用时（如同时读取 3 个文件），它们被串行执行，浪费时间。

## Claude Code 参考

### 并发安全标记

**文件**: `src/Tool.ts`

每个工具实现 `isConcurrencySafe(input): boolean` 方法：
- 默认返回 `false`（`buildTool()` 的安全默认值）
- 只读工具（Glob、Grep、FileRead）返回 `true`
- 写入工具（FileEdit、FileWrite、Bash）返回 `false`

### 工具池排序

**文件**: `src/tools.ts:345-367` — `assembleToolPool()`

工具按名称排序以保证 prompt cache 稳定性。排序后，LLM 每次看到的工具列表顺序一致，减少 cache 失效。

### 并行执行模式

Claude Code 在 `query()` 循环中，当模型返回多个 tool_use 块时：
1. 按 `isConcurrencySafe()` 分组
2. 安全的工具并行执行（`Promise.all`）
3. 不安全的工具顺序执行
4. 混合场景：先并行执行安全组，再顺序执行不安全组

## 改进方案

### 1. 添加 isConcurrencySafe 标记

修改 `src/harness/types.ts` 的 `Tool` 接口：

```typescript
export interface Tool {
  name: string
  description: string
  inputSchema: unknown
  riskLevel: RiskLevel
  isConcurrencySafe?: boolean  // 新增，默认 false
  execute(input: unknown, context: ToolContext): Promise<ToolResult>
}
```

标记各工具：
```typescript
// src/tools/grep.ts
isConcurrencySafe: true

// src/tools/glob.ts
isConcurrencySafe: true

// src/tools/readFile.ts
isConcurrencySafe: true

// src/tools/bash.ts
isConcurrencySafe: false

// src/tools/writeFile.ts
isConcurrencySafe: false
```

### 2. 修改工具执行循环

修改 `src/harness/loop.ts`：

```typescript
// 分组
const safeCalls = toolCalls.filter(tc => {
  const tool = tools.find(t => t.name === tc.name)
  return tool?.isConcurrencySafe === true
})
const unsafeCalls = toolCalls.filter(tc => {
  const tool = tools.find(t => t.name === tc.name)
  return tool?.isConcurrencySafe !== true
})

// 并行执行安全工具
const safeResults = safeCalls.length > 0
  ? await Promise.all(safeCalls.map(tc => toolRunner.run(tc, signal)))
  : []

// 顺序执行不安全工具
const unsafeResults: ToolResultRecord[] = []
for (const tc of unsafeCalls) {
  unsafeResults.push(await toolRunner.run(tc, signal))
}

// 合并结果（保持原始顺序）
const results = mergeResults(toolCalls, safeResults, unsafeResults)
```

### 3. 结果顺序保证

模型期望 tool_result 的顺序与 tool_use 一致。合并时需按原始 `toolCalls` 数组顺序排列：

```typescript
function mergeResults(
  original: ToolCall[],
  safeResults: ToolResultRecord[],
  unsafeResults: ToolResultRecord[],
): ToolResultRecord[] {
  const safeMap = new Map(safeResults.map(r => [r.toolUseId, r]))
  const unsafeMap = new Map(unsafeResults.map(r => [r.toolUseId, r]))
  return original.map(tc => safeMap.get(tc.id) ?? unsafeMap.get(tc.id)!)
}
```

## 涉及的 MyAgent 文件

| 文件 | 改动 |
|------|------|
| `src/harness/types.ts` | Tool 接口添加 `isConcurrencySafe?` |
| `src/harness/loop.ts` | 工具执行循环改为分组并行 |
| `src/tools/grep.ts` | 标记 `isConcurrencySafe: true` |
| `src/tools/glob.ts` | 标记 `isConcurrencySafe: true` |
| `src/tools/readFile.ts` | 标记 `isConcurrencySafe: true` |
