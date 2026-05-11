# MyAgent

**MyAgent** 是一个轻量级、可自托管的 CLI 编程 Agent，受 [Claude Code]架构启发，支持 **Anthropic** 和 **OpenAI** 兼容 API。

## 特性

- **多 Provider 支持** — 原生支持 Anthropic SDK（流式、Prompt Caching）和 OpenAI SDK（Prompt Cache Key），任意兼容 API 均可接入
- **长链推理** — 自动上下文压缩、max_tokens 自动升级、Token 预算管理，支持深度多步推理
- **会话持久化** — 自动保存完整对话记录（含消息、工具调用、压缩边界），支持按 ID 前缀断点续聊
- **技能系统** — `SKILL.md` 文件（YAML frontmatter + Markdown）零代码定义技能，自动发现并注入 Agent 上下文
- **上下文管理** — Token 计数驱动的自动压缩演进，保留关键上下文的同时控制上下文窗口
- **工具系统** — 内置文件操作、搜索、Shell 执行等工具，支持权限分级门控
- **轻量终端 UI** — 基于 `readline` 的 REPL，无 Ink/React 依赖，支持多行输入、Tab 补全、历史记录

## 快速开始

```bash
# 安装依赖（需要 Node.js >= 22）
bun install
# 或
npm install

# 创建配置文件
mkdir -p .myagent/skills
```

创建 `.myagent/config.json`：

```json
{
  "models": {
    "claude": {
      "provider": "anthropic",
      "model": "claude-sonnet-4-20250514",
      "apiKey": "sk-ant-..."
    },
    "deepseek": {
      "provider": "openai",
      "model": "deepseek-chat",
      "apiKey": "sk-...",
      "baseUrl": "https://api.deepseek.com/v1"
    }
  },
  "defaultModel": "claude",
  "agent": {
    "system": "你是 Hanekawa，一个 CLI 编程助手。"
  }
}
```

```bash
# 启动新会话
bun run dev new

# 查看会话列表
bun run dev list

# 恢复历史会话
bun run dev resume <session-id-or-prefix>
```

## 项目结构

```
myagent/
├── src/
│   ├── entrypoints/cli.ts     CLI 入口，命令调度 + REPL 会话
│   ├── harness/               Agent 核心引擎
│   │   ├── loop.ts            Agent 主循环：推理 → 工具 → 循环
│   │   ├── contextBuilder.ts  上下文构建（System Prompt、技能注入、压缩恢复）
│   │   ├── compact.ts         自动上下文压缩
│   │   ├── toolRunner.ts      工具执行与记录
│   │   ├── permissions.ts     权限门控（safe/confirm/dangerous 三级）
│   │   ├── requestPrep.ts     请求预处理与工具结果压缩
│   │   ├── cacheControl.ts    Anthropic Prompt Caching 断点控制
│   │   ├── cacheBreakDetection.ts  缓存断点碰撞检测
│   │   ├── usage.ts           Token 用量计算与成本统计
│   │   └── types.ts           核心类型定义
│   ├── config/                Provider 与模型配置
│   │   ├── service.ts         配置读写
│   │   ├── providers.ts       AnthropicProvider / OpenAIProvider 实现
│   │   └── retry.ts           可重试错误处理
│   ├── prompts/               上下文预算与消息编排
│   │   ├── budget.ts          Token 估算与上下文窗口管理
│   │   └── composer.ts        消息组合器
│   ├── tools/                 内置工具
│   │   ├── bash.ts, grep.ts, glob.ts, readFile.ts
│   │   ├── writeFile.ts, editFile.ts, deleteFile.ts
│   │   ├── taskTools.ts       任务追踪工具
│   │   ├── skillTool.ts       技能调用工具
│   │   └── webSearch.ts       网络搜索工具
│   ├── sessions/service.ts    会话持久化存储
│   ├── services/skills/       技能发现与加载
│   └── utils/                 路径与 JSON 工具
├── test/                      测试文件
└── .myagent/                  运行时目录（配置、会话、技能）
```

## Agent 工作流

```
用户输入
    │
    ▼
┌─ Session 持久化 ──────────┐
│  记录消息到 .myagent/sessions/
└───────────────────────────┘
    │
    ▼
┌─ Context 构建 ─────────────┐
│  System Prompt              │
│  + 可用技能列表             │
│  + 环境信息（平台、目录）   │
│  + 当前日期                 │
│  + 压缩恢复（最近文件/技能）│
│  + 会话历史                 │
└───────────────────────────┘
    │
    ▼
┌─ Auto-Compact 检查 ────────┐
│  Token 超阈值 → LLM 摘要压缩 │
│  插入 compact_boundary 记录 │
└───────────────────────────┘
    │
    ▼
┌─ 推理循环（最多 100 轮）───┐
│  LLM Provider 调用          │
│    │                       │
│    ├─ 直接文本响应 → 返回   │
│    │                       │
│    └─ 工具调用 → ToolRunner │
│        · 权限检查           │
│        · 执行工具           │
│        · 记录结果           │
│        · 返回 LLM 继续      │
└───────────────────────────┘
```

## Provider 配置

### Anthropic

直接使用 Anthropic SDK，支持：

- **流式响应**（默认，90s 空闲超时后降级为非流式）
- **Prompt Caching**（System Prompt 最后一块 + 用户消息最后一条自动标记 `ephemeral` 缓存）
- 可通过 `MYAGENT_PROMPT_CACHE_1H=1` 启用 1 小时缓存 TTL
- 通过 `MYAGENT_DISABLE_PROMPT_CACHING=1` 全局禁用

### OpenAI / 兼容 API

兼容 OpenAI Chat Completions API 格式，支持：

- **Prompt Cache Key**（基于 model + system + tools 的 SHA256 哈希，格式 `myagent:<hash>`）
- 自动适配 `max_tokens`、`tools` 等参数
- 适用于 DeepSeek、通义千问、GLM 等任意兼容 API

## 技能系统

技能存储在 `.myagent/skills/<name>/SKILL.md`，格式：

```markdown
---
name: my-skill
description: 技能的简短描述
---

技能内容（Markdown 格式），将注入到 Agent 的 System Prompt 中。
```

技能会在会话启动时自动发现，可通过 `/skills list` 查看，或通过 Skill 工具在对话中调用。

## 会话管理

```bash
# 列出所有会话
myagent list

# 恢复指定会话（支持 ID 前缀模糊匹配）
myagent resume abc123
```

会话数据保存于 `.myagent/sessions/`，每条会话含完整的历史记录（消息、工具调用、压缩边界）。

## 开发

```bash
# 类型检查
bun run typecheck

# 运行测试
bun run test
```

## 设计理念

MyAgent 是一个 **minimal 实现**，聚焦 Agent 核心能力：

- **单 Agent 架构**：不含多 Agent 编排，保持简单可靠
- **文件优先**：配置、会话、技能均以文件形式存储，透明可编辑
- **Provider 透明**：同一套工具/上下文系统，切换后端无需修改代码
- **尊重终端**：readline REPL，无重量级 UI 框架依赖

## 许可

MIT
