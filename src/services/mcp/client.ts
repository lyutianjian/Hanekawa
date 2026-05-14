import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { McpServerConfig } from './types.js'

export async function connectMcpServer(config: McpServerConfig): Promise<Client> {
  if (config.transport === 'stdio') {
    if (!config.command) {
      throw new Error('stdio transport requires "command"')
    }

    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args,
    })

    const client = new Client({ name: 'myagent', version: '0.1.0' })
    await client.connect(transport)
    return client
  }

  throw new Error(`Unsupported transport: ${config.transport}`)
}

export async function disconnectMcpServer(client: Client): Promise<void> {
  await client.close()
}
