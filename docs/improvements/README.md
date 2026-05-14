# MyAgent 改进参考文件

> 基于 Claude Code 源码分析，每个文件聚焦一个改进领域，精确引用对应源码位置。

## 改进路线图

### P0 — 核心体验

| # | 文件 | 主题 | 难度 |
|---|------|------|------|
| 1 | [01-streaming-output.md](01-streaming-output.md) | 流式输出显示 | 中 |
| 2 | [02-project-context.md](02-project-context.md) | 项目上下文加载 (MYAGENT.md) | 低 |
| 3 | [03-slash-commands.md](03-slash-commands.md) | 斜杠命令系统 | 中 |

### P1 — 功能完善

| # | 文件 | 主题 | 难度 |
|---|------|------|------|
| 4 | [04-mcp-integration.md](04-mcp-integration.md) | MCP 集成 | 高 |
| 5 | [05-permission-system.md](05-permission-system.md) | 权限系统增强 | 中 |
| 6 | [06-parallel-tool-execution.md](06-parallel-tool-execution.md) | 并行工具执行 | 低 |
| 7 | [07-session-storage.md](07-session-storage.md) | 会话存储优化 | 低 |

### P2 — 体验优化

| # | 文件 | 主题 | 难度 |
|---|------|------|------|
| 8 | [08-abort-signal.md](08-abort-signal.md) | Abort 信号传递 | 低 |
| 9 | [09-provider-optimization.md](09-provider-optimization.md) | Provider 优化 (OpenAI retry/streaming) | 中 |
| 10 | [10-token-estimation.md](10-token-estimation.md) | Token 估算精度 | 低 |
| 11 | [11-context-compaction.md](11-context-compaction.md) | 上下文压缩增强 | 中 |

### P3 — 远期目标

| # | 文件 | 主题 | 难度 |
|---|------|------|------|
| 12 | [12-settings-system.md](12-settings-system.md) | 多级设置系统 | 中 |

## 综合参考

- [Claude Code 源码架构参考文档](../claude-code-source-reference.md) — 完整架构分析与对比矩阵

## 文件统一结构

每个改进文件包含：

1. **现状** — MyAgent 当前实现的问题
2. **Claude Code 参考** — 精确文件路径 + 行号 + 关键代码片段
3. **改进方案** — 具体实现步骤和代码示例
4. **涉及的 MyAgent 文件** — 需要修改的文件清单
