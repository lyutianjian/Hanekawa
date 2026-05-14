export interface McpServerConfig {
  transport: 'stdio' | 'sse'
  command?: string
  args?: string[]
  url?: string
}

export interface McpTool {
  name: string
  description: string
  inputSchema: unknown
}

export interface McpServer {
  name: string
  config: McpServerConfig
  tools: McpTool[]
}
