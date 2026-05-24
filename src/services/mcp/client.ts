import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { McpServerConfig } from './types.js'

const DEFAULT_MCP_TIMEOUT_MS = 60_000

export function getMcpTimeoutMs(config: McpServerConfig): number {
  if (config.timeoutMs === undefined) return DEFAULT_MCP_TIMEOUT_MS
  if (!Number.isInteger(config.timeoutMs) || config.timeoutMs < 1) {
    throw new Error('"timeoutMs" must be a positive integer')
  }
  return config.timeoutMs
}

export async function connectMcpServer(config: McpServerConfig): Promise<Client> {
  if (config.transport === 'stdio') {
    if (!config.command) {
      throw new Error('stdio transport requires "command"')
    }
    if (config.args !== undefined && (!Array.isArray(config.args) || config.args.some((arg) => typeof arg !== 'string'))) {
      throw new Error('stdio transport "args" must be an array of strings')
    }
    const timeoutMs = getMcpTimeoutMs(config)

    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args,
    })

    const client = new Client({ name: 'myagent', version: '0.1.0' })
    try {
      await client.connect(transport, { timeout: timeoutMs })
    } catch (error) {
      await client.close().catch(() => {})
      throw error
    }
    return client
  }

  throw new Error(`Unsupported transport: ${config.transport}`)
}

export async function disconnectMcpServer(client: Client): Promise<void> {
  await client.close()
}
