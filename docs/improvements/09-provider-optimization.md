# 09 — Provider 优化 (OpenAI Retry/Streaming)

> 优先级：P2 | 难度：中 | 影响：可靠性

## 现状

- `AnthropicProvider` 有 retry 逻辑（`src/config/retry.ts`），但 `OpenAIProvider` 缺少 retry，瞬时 API 错误直接失败
- `OpenAIProvider` 使用非流式 `chat.completions.create()`，无渐进输出
- 两个 provider 都缺少流式空闲超时保护
- 错误处理不够细粒度，不区分可重试/不可重试错误

## Claude Code 参考

### Retry 逻辑

**文件**: `src/services/api/withRetry.ts:170` — `withRetry()`

异步生成器，yield `SystemAPIErrorMessage` 重试状态消息。

**常量** (行 53-56)：
```typescript
DEFAULT_MAX_RETRIES = 10
MAX_529_RETRIES = 3
BASE_DELAY_MS = 500
```

**指数退避** (行 530)：
```typescript
const baseDelay = Math.min(BASE_DELAY_MS * Math.pow(2, attempt - 1), maxDelayMs)
const jitter = Math.random() * 0.25 * baseDelay
return baseDelay + jitter
```
500ms 起步，指数增长，上限 32s，25% 抖动。

**重试判断** (行 696 — `shouldRetry`)：
- 重试：408 (timeout)、409 (lock)、429 (rate limit)、401 (auth)、403 (revoked)、5xx (server)、连接错误、529 (overloaded)
- 不重试：400 (bad request)、404 (not found)、用户取消
- 遵循 `x-should-retry` 响应头

**529 处理** (行 327-364)：
- 追踪连续 529 次数
- 3 次后触发模型降级（如果配置了 fallbackModel）
- 非前台查询源立即放弃（避免放大）

### 错误处理

**文件**: `src/services/api/errors.ts:425` — `getAssistantMessageFromError()`

将 API 错误转换为用户友好的 `AssistantMessage`：
- 超时错误、图片/PDF 大小错误
- 速率限制（429，含详细 quota headers）
- Prompt 过长、tool_use/tool_result 并发错误
- 认证失败、组织禁用、无效模型名

**文件**: `src/services/api/errors.ts:965` — `classifyAPIError()`

映射到标准化类别：`'rate_limit'`、`'server_overload'`、`'prompt_too_long'`

### API 客户端工厂

**文件**: `src/services/api/client.ts:88` — `getAnthropicClient()`

根据环境变量创建不同后端：
- Direct API（默认）
- AWS Bedrock
- Azure Foundry
- Google Vertex

### Prompt 缓存控制

**文件**: `src/services/api/claude.ts:358-374` — `getCacheControl()`

```typescript
function getCacheControl({ scope, querySource }) {
  return {
    type: 'ephemeral',
    ...(should1hCacheTTL(querySource) && { ttl: '1h' }),
    ...(scope === 'global' && { scope }),
  }
}
```

缓存标记位置：
- System prompt blocks（按 cacheScope 分割）
- 最后一条消息的最后一个 content block
- Tool schemas（per-request overlay）

## 改进方案

### 1. 统一 Retry 模块

重构 `src/config/retry.ts` 为通用重试器：

```typescript
interface RetryConfig {
  maxRetries: number
  baseDelayMs: number
  maxDelayMs: number
  jitterFactor: number
  shouldRetry: (error: Error, attempt: number) => boolean
}

async function withRetry<T>(
  fn: () => Promise<T>,
  config: Partial<RetryConfig> = {},
): Promise<T> {
  const { maxRetries = 5, baseDelayMs = 500, maxDelayMs = 32000, jitterFactor = 0.25 } = config
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn()
    } catch (error) {
      if (attempt === maxRetries || !shouldRetryError(error)) throw error
      const delay = Math.min(baseDelayMs * Math.pow(2, attempt - 1), maxDelayMs)
      const jitter = Math.random() * jitterFactor * delay
      await sleep(delay + jitter)
    }
  }
  throw new Error('Unreachable')
}

function shouldRetryError(error: Error): boolean {
  if (error.status === 429 || error.status === 529) return true
  if (error.status >= 500) return true
  if (error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT') return true
  return false
}
```

### 2. OpenAI Provider 添加 Retry

```typescript
class OpenAIProvider implements ModelProvider {
  async createMessage(request: ModelRequest): Promise<ModelResponse> {
    return withRetry(() => this._createMessage(request), {
      maxRetries: 5,
      shouldRetry: (error) => error.status === 429 || error.status >= 500,
    })
  }
}
```

### 3. OpenAI Provider 添加 Streaming

```typescript
async *streamMessage(request: ModelRequest): AsyncGenerator<StreamChunk> {
  const stream = await this.client.chat.completions.create({
    model: request.model,
    messages: this.buildMessages(request),
    tools: this.buildTools(request),
    stream: true,
  })
  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta
    if (delta?.content) yield { type: 'text', text: delta.content }
    if (delta?.tool_calls) yield { type: 'tool_call', data: delta.tool_calls }
  }
}
```

### 4. 错误分类与用户友好消息

```typescript
function classifyError(error: Error): string {
  if (error.status === 429) return 'rate_limit'
  if (error.status === 529) return 'overloaded'
  if (error.status >= 500) return 'server_error'
  if (error.status === 401) return 'auth_error'
  if (error.code === 'ETIMEDOUT') return 'timeout'
  return 'unknown'
}

function getUserMessage(errorClass: string): string {
  switch (errorClass) {
    case 'rate_limit': return 'API rate limit reached. Retrying...'
    case 'overloaded': return 'API is overloaded. Retrying with backoff...'
    case 'auth_error': return 'Authentication failed. Check your API key.'
    case 'timeout': return 'Request timed out. Retrying...'
    default: return 'An API error occurred.'
  }
}
```

## 涉及的 MyAgent 文件

| 文件 | 改动 |
|------|------|
| `src/config/retry.ts` | 重构为通用重试器，支持配置化 |
| `src/config/providers.ts` | Anthropic 和 OpenAI 均集成 retry + streaming |
| `src/harness/types.ts` | ModelProvider 接口添加 `streamMessage?()` |
| `src/harness/usage.ts` | 流式模式下的 usage 追踪 |
