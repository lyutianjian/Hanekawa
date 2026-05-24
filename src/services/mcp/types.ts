export interface McpServerConfig {
  transport: 'stdio' | 'sse'
  command?: string
  args?: string[]
  url?: string
  timeoutMs?: number
}

export interface McpTool {
  name: string
  description: string
  inputSchema: unknown
  annotations?: Record<string, unknown>
}

export interface McpServer {
  name: string
  config: McpServerConfig
  tools: McpTool[]
}
