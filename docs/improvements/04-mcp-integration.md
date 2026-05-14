# 04 — MCP 集成

> 优先级：P1 | 难度：高 | 影响：生态扩展核心

## 现状

`package.json` 声明了 `@modelcontextprotocol/sdk` 依赖，但零 MCP 客户端代码。无连接管理、无工具发现、无配置加载。这是最大的功能缺口。

## Claude Code 参考

### MCP 类型定义

**文件**: `src/services/mcp/types.ts`

```typescript
// 行 11-20: 配置作用域
ConfigScope = z.enum(['local', 'user', 'project', 'dynamic', 'enterprise', 'claudeai', 'managed'])

// 行 23-26: 传输类型
Transport = z.enum(['stdio', 'sse', 'sse-ide', 'http', 'ws', 'sdk'])

// 行 124-161: 服务器配置（8 种传输的联合类型）
McpServerConfig = z.union([
  McpStdioServerConfig,    // { transport: 'stdio', command, args?, env? }
  McpSSEServerConfig,      // { transport: 'sse', url }
  McpHTTPServerConfig,     // { transport: 'http', url }
  McpWebSocketServerConfig, // { transport: 'ws', url }
  // ... 其他 4 种
])

// 行 180-192: 已连接服务器
ConnectedMCPServer = {
  client: Client
  name: string
  type: 'connected'
  capabilities: ServerCapabilities
  serverInfo?: Implementation
  instructions?: string
  config: ScopedMcpServerConfig
  cleanup: () => Promise<void>
}

// 行 221-226: 服务器连接状态联合
MCPServerConnection =
  | ConnectedMCPServer
  | FailedMCPServer       // { type: 'failed', error }
  | NeedsAuthMCPServer    // { type: 'needs_auth' }
  | PendingMCPServer      // { type: 'pending' }
  | DisabledMCPServer     // { type: 'disabled' }
```

### MCP 客户端连接

**文件**: `src/services/mcp/client.ts`

- 使用 `@modelcontextprotocol/sdk` 的 `Client` 类
- 支持传输：`StdioClientTransport`、`SSEClientTransport`、`StreamableHTTPClientTransport`、`WebSocketTransport`
- 工具发现：`fetchToolsForClient()` (行 1766-1839)，将 MCP 工具映射到 `MCPTool` 模板
- 错误类型：`McpAuthError` (行 152)、`McpSessionExpiredError` (行 165)

### MCP 配置加载

**文件**: `src/services/mcp/config.ts`

- `getClaudeCodeMcpConfigs()` (行 1071)：按优先级合并 `enterprise > user > project > local`
- `getAllMcpConfigs()` (行 1258)：添加 claude.ai 连接器服务器
- `dedupPluginMcpServers()` (行 223)：按 command/URL 签名去重
- `isMcpServerDenied()` (行 364)：检查 deniedMcpServers
- `isMcpServerAllowedByPolicy()` (行 417)：检查 allowedMcpServers 白名单

### MCP 工具包装

**文件**: `src/tools/MCPTool/MCPTool.ts:27`

```typescript
const MCPTool = buildTool({
  name: 'mcp_tool_template',
  inputSchema: z.object({}).passthrough(),
  checkPermissions: () => ({ behavior: 'passthrough' }),
  // 大部分方法在 client.ts 中按服务器覆写
})
```

命名规范化：`mcp__<server>__<tool>`

### 工具池合并

**文件**: `src/tools.ts:345-367` — `assembleToolPool()`

1. 获取内置工具（按权限过滤）
2. 过滤 MCP 工具（按 deny 规则）
3. 排序（内置在前，保证 prompt cache 稳定性）
4. 去重（内置工具优先于同名 MCP 工具）

### 连接管理

**文件**: `src/services/mcp/useManageMCPConnections.ts` (46KB)

- 连接、重连（指数退避，最多 5 次）
- 工具/命令/资源获取
- 通知订阅：`ToolListChanged`、`ResourceListChanged`、`PromptListChanged`

## 改进方案

### 1. 最小可行 MCP（stdio 传输）

新建 `src/services/mcp/` 模块：

```
src/services/mcp/
  ├── types.ts          // 配置和连接类型
  ├── client.ts         // MCP 客户端封装
  ├── config.ts         // 从 .myagent/config.json 加载 MCP 配置
  └── toolWrapper.ts    // 将 MCP 工具转换为 MyAgent Tool
```

### 2. 配置格式

在 `.myagent/config.json` 中添加 `mcpServers` 字段：

```json
{
  "mcpServers": {
    "filesystem": {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/dir"]
    }
  }
}
```

### 3. 客户端连接（stdio 优先）

```typescript
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

async function connectStdioServer(config: McpStdioServerConfig): Promise<Client> {
  const transport = new StdioClientTransport({
    command: config.command,
    args: config.args,
    env: config.env,
  })
  const client = new Client({ name: 'myagent', version: '0.1.0' })
  await client.connect(transport)
  return client
}
```

### 4. MCP 工具包装

```typescript
function wrapMcpTool(serverName: string, mcpTool: MCPToolDefinition): Tool {
  return {
    name: `mcp__${serverName}__${mcpTool.name}`,
    description: mcpTool.description ?? '',
    inputSchema: mcpTool.inputSchema,
    riskLevel: 'confirm',
    async execute(input, context) {
      const result = await client.callTool({ name: mcpTool.name, arguments: input })
      return { ok: !result.isError, content: JSON.stringify(result.content) }
    },
  }
}
```

### 5. 工具池集成

修改 `src/harness/loop.ts`，在构建工具列表时合并 MCP 工具：

```typescript
const mcpTools = await loadMcpTools(config)
const allTools = [...builtinTools, ...mcpTools]
```

## 涉及的 MyAgent 文件

| 文件 | 改动 |
|------|------|
| `src/services/mcp/types.ts` | **新建** — 配置和连接类型 |
| `src/services/mcp/client.ts` | **新建** — MCP 客户端封装 |
| `src/services/mcp/config.ts` | **新建** — 配置加载 |
| `src/services/mcp/toolWrapper.ts` | **新建** — 工具包装 |
| `src/config/service.ts` | 添加 `mcpServers` 配置字段 |
| `src/harness/loop.ts` | 合并 MCP 工具到工具池 |
| `src/harness/types.ts` | Tool 接口可选添加 `isMcp?` 标记 |
