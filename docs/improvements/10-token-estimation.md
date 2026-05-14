# 10 — Token 估算精度

> 优先级：P2 | 难度：低 | 影响：上下文管理准确性

## 现状

`src/prompts/budget.ts` 的 `countTextTokens()` 使用字符启发式：
- ASCII：4 字符 ≈ 1 token
- CJK：2 字符 ≈ 1 token

这对代码、JSON、Markdown 等结构化文本的估算偏差可达 30-50%，导致上下文压缩时机不准确。

## Claude Code 参考

### Token 估算服务

**文件**: `src/services/tokenEstimation.ts`

Claude Code 使用精确的 tokenizer 而非字符启发式。具体实现依赖构建目标，但核心模式是：
- 对 system prompt 使用精确计数
- 对历史消息使用采样估算（避免每轮都 tokenize 全部内容）
- 对工具结果使用混合策略（小结果精确计数，大结果采样）

### 上下文窗口管理

**文件**: `src/services/compact/autoCompact.ts:72`

```typescript
getAutoCompactThreshold(model) = getEffectiveContextWindowSize(model) - AUTOCOMPACT_BUFFER_TOKENS
// AUTOCOMPACT_BUFFER_TOKENS = 13_000
```

精确的 token 计数对决定何时触发自动压缩至关重要。偏差过大会导致：
- 过早压缩：丢失有用的上下文
- 过晚压缩：API 返回 prompt-too-long 错误

### Usage 追踪

**文件**: `src/services/api/claude.ts:2924` — `updateUsage()`

从 API 响应中获取精确的 token 使用量：
- `input_tokens`
- `cache_creation_input_tokens`
- `cache_read_input_tokens`
- `output_tokens`

这些是服务端精确计数，用于成本计算和使用量报告。

## 改进方案

### 1. 集成 tiktoken

安装 `tiktoken` 或 `js-tiktoken` 包：

```bash
npm install js-tiktoken
```

```typescript
import { encodingForModel } from 'js-tiktoken'

const enc = encodingForModel('claude-3-5-sonnet-20241022')

export function countTokens(text: string): number {
  return enc.encode(text).length
}
```

### 2. 分层估算策略

```typescript
export function estimateTokens(text: string, mode: 'precise' | 'fast' = 'fast'): number {
  if (mode === 'precise') {
    return countTokens(text)  // 精确但慢
  }
  // 快速估算：对典型代码/文本的系数校准
  const asciiChars = text.replace(/[^\x00-\x7F]/g, '').length
  const cjkChars = text.length - asciiChars
  return Math.ceil(asciiChars / 3.5 + cjkChars / 1.5)
  // 校准系数：3.5（非 4）和 1.5（非 2），基于代码文本实测
}
```

### 3. 缓存 tokenizer 实例

```typescript
let cachedEncoder: Tiktoken | null = null

function getEncoder(): Tiktoken {
  if (!cachedEncoder) {
    cachedEncoder = encodingForModel('claude-3-5-sonnet-20241022')
  }
  return cachedEncoder
}
```

### 4. API 响应校准

利用 API 返回的精确 `input_tokens` 校准本地估算：

```typescript
// 在每次 API 调用后
const estimated = estimateTokens(systemPrompt + messagesText)
const actual = response.usage.input_tokens
const calibrationFactor = actual / estimated
// 保存校准因子，后续估算乘以该因子
```

## 涉及的 MyAgent 文件

| 文件 | 改动 |
|------|------|
| `src/prompts/budget.ts` | 替换 `countTextTokens()` 为精确实现 |
| `src/harness/compact.ts` | 使用精确 token 计数决定压缩时机 |
| `src/harness/usage.ts` | 利用 API 响应校准本地估算 |
| `package.json` | 添加 `js-tiktoken` 依赖 |
