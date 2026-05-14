# 01 — 流式输出显示

> 优先级：P0 | 难度：中 | 影响：用户体验核心

## 现状

MyAgent 的 Anthropic provider 在 `src/config/providers.ts` 中使用 `client.messages.stream()` 发起流式请求，但丢弃所有流事件，仅等待 `stream.finalMessage()` 返回完整响应。用户看到 "Thinking..." 后等待数秒，然后完整响应一次性出现。

OpenAI provider 使用 `chat.completions.create()` 非流式调用，同样无渐进输出。

## Claude Code 参考

### 流式请求创建

**文件**: `src/services/api/claude.ts:1818-1836`

Claude Code 使用原始流 API（非高级 `BetaMessageStream` 包装器），以避免 `partialParse()` 的 O(n^2) JSON 解析开销：

```typescript
const result = await anthropic.beta.messages
  .create(
    { ...params, stream: true },
    { signal, headers: { [CLIENT_REQUEST_ID_HEADER]: clientRequestId } },
  )
  .withResponse()
```

### 流事件处理循环

**文件**: `src/services/api/claude.ts:1940-2304`

核心循环 `for await (const part of stream)` 处理 5 种事件类型：

| 事件 | 行号 | 处理逻辑 |
|------|------|----------|
| `message_start` | 1980 | 捕获初始 `partialMessage`，记录 TTFT，初始化 usage |
| `content_block_start` | 1995 | 初始化内容块索引（text/tool_use/thinking） |
| `content_block_delta` | 2053 | 增量追加：`text_delta.text`、`input_json_delta.partial_json`、`thinking_delta.thinking` |
| `content_block_stop` | 2171 | 完成内容块，通过 `normalizeContentFromAPI()` 标准化 |
| `message_delta` | 2213 | 更新最终 usage（output_tokens, stop_reason），计算 USD 成本 |

每个事件后 yield：
```typescript
yield { type: 'stream_event', event: part, ...(part.type === 'message_start' ? { ttftMs } : undefined) }
```

### 流式空闲看门狗

**文件**: `src/services/api/claude.ts:1868-1928`

- 超时：`CLAUDE_STREAM_IDLE_TIMEOUT_MS`，默认 90 秒
- 半超时时发出警告
- 超时后调用 `releaseStreamResources()` 中止流
- 中止后触发非流式降级

### 非流式降级

**文件**: `src/services/api/claude.ts:818-916`

流式失败时（网络错误、超时、404）降级到非流式调用，`max_tokens` 上限 64,000。

## 改进方案

### 1. Anthropic Provider 流式输出

```typescript
// src/config/providers.ts — AnthropicProvider.createMessage()
async *streamMessage(request: ModelRequest): AsyncGenerator<{ type: string; text?: string; toolCall?: ToolCall }> {
  const stream = this.client.messages.stream({
    model: request.model,
    max_tokens: request.maxOutputTokens ?? 4096,
    system: request.system,
    messages: request.messages.map(m => ({ role: m.role, content: m.content })),
    tools: request.tools?.map(t => ({ name: t.name, description: t.description, input_schema: t.inputSchema })),
  })

  for await (const event of stream) {
    if (event.type === 'content_block_delta') {
      if (event.delta.type === 'text_delta') {
        yield { type: 'text', text: event.delta.text }
      }
      if (event.delta.type === 'input_json_delta') {
        yield { type: 'tool_input_delta', text: event.delta.partial_json }
      }
    }
  }
}
```

### 2. OpenAI Provider 流式输出

```typescript
const stream = await this.client.chat.completions.create({
  ...params,
  stream: true,
})
for await (const chunk of stream) {
  const delta = chunk.choices[0]?.delta
  if (delta?.content) yield { type: 'text', text: delta.content }
}
```

### 3. REPL 渐进式渲染

在 `src/entrypoints/cli.ts` 的 REPL 循环中，调用流式接口并逐 token 输出到 stdout：

```typescript
process.stdout.write('\n')
for await (const chunk of provider.streamMessage(request)) {
  if (chunk.type === 'text') {
    process.stdout.write(chunk.text)
  }
}
process.stdout.write('\n')
```

### 4. 空闲超时保护

参考 Claude Code 的看门狗模式，添加 configurable 超时（默认 60s），超时后降级到非流式。

## 涉及的 MyAgent 文件

| 文件 | 改动 |
|------|------|
| `src/config/providers.ts` | 添加流式生成器方法，Anthropic 和 OpenAI 均需改动 |
| `src/harness/types.ts` | `ModelProvider` 接口添加 `streamMessage?()` 可选方法 |
| `src/harness/loop.ts` | 支持流式调用路径，显示渐进输出 |
| `src/entrypoints/cli.ts` | REPL 循环中集成流式渲染 |
| `src/harness/usage.ts` | 流式模式下的 usage 追踪 |
