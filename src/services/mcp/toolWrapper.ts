import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { Tool } from '../../harness/types.js'
import type { McpTool } from './types.js'

export function wrapMcpTool(serverName: string, mcpTool: McpTool, client: Client): Tool {
  return {
    name: `mcp__${serverName}__${mcpTool.name}`,
    description: mcpTool.description,
    inputSchema: mcpTool.inputSchema,
    riskLevel: 'confirm',
    async execute(input, _context) {
      const result = await client.callTool({
        name: mcpTool.name,
        arguments: input as Record<string, unknown>,
      })

      const content = typeof result.content === 'string'
        ? result.content
        : JSON.stringify(result.content)

      return {
        ok: !result.isError,
        content: content || '(no output)',
      }
    },
  }
}
