# 08 — Abort 信号传递

> 优先级：P2 | 难度：低 | 影响：用户体验

## 现状

`src/harness/toolRunner.ts` 的 `run()` 方法接受 `AbortSignal` 参数但不传递给 `tool.execute()`。长时间运行的工具（如 bash 命令）无法被 Ctrl+C 中断。用户必须等待命令完成或杀死整个进程。

## Claude Code 参考

### ToolUseContext 中的 AbortController

**文件**: `src/Tool.ts`

`ToolUseContext` 包含 `abortController: AbortController`，每个工具调用都能访问：

```typescript
type ToolUseContext = {
  abortController: AbortController
  // ... 其他字段
}
```

工具实现中直接使用 `context.abortController.signal`：

```typescript
// BashTool 示例
async call(input, context) {
  const proc = spawn(input.command, { signal: context.abortController.signal })
  // signal 触发时自动终止子进程
}
```

### 智能体级 Abort

**文件**: `src/tools/AgentTool/runAgent.ts`

同步子智能体共享父级的 `abortController`。异步子智能体有独立的 `AbortController`。

## 改进方案

### 1. ToolContext 添加 abortSignal

修改 `src/harness/types.ts`：

```typescript
export interface ToolContext {
  cwd: string
  sessionId: string
  readFiles: Set<string>
  abortSignal?: AbortSignal  // 新增
  // ...
}
```

### 2. ToolRunner 传递信号

修改 `src/harness/toolRunner.ts`：

```typescript
async run(toolCall: ToolCall, signal: AbortSignal): Promise<ToolResultRecord> {
  const context: ToolContext = {
    cwd: this.cwd,
    sessionId: this.sessionId,
    readFiles: this.readFiles,
    abortSignal: signal,  // 传递信号
  }
  return tool.execute(toolCall.input, context)
}
```

### 3. BashTool 中断支持

修改 `src/tools/bash.ts`：

```typescript
async execute(input, context) {
  return new Promise((resolve) => {
    const proc = spawn('bash', ['-c', input.command], {
      cwd: context.cwd,
      signal: context.abortSignal,  // Node.js 原生支持
    })

    context.abortSignal?.addEventListener('abort', () => {
      proc.kill('SIGTERM')
    })

    // ... 收集 stdout/stderr
  })
}
```

### 4. 其他工具的 abort 检查

对于不直接支持 signal 的工具，在等待循环中检查：

```typescript
async execute(input, context) {
  while (notDone) {
    if (context.abortSignal?.aborted) {
      return { ok: false, content: 'Operation cancelled by user' }
    }
    // ... 继续工作
  }
}
```

## 涉及的 MyAgent 文件

| 文件 | 改动 |
|------|------|
| `src/harness/types.ts` | ToolContext 添加 `abortSignal?` |
| `src/harness/toolRunner.ts` | 传递 signal 到 tool.execute() |
| `src/tools/bash.ts` | 使用 signal 终止子进程 |
| `src/harness/loop.ts` | 确保 AbortController 正确传递 |
