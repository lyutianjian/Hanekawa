import {
  connectManagedMcpServer,
  getMcpTimeoutMs,
  loadMcpConfig,
  wrapMcpTool,
} from '../services/mcp/index.js'
import type { ManagedMcpClient, McpServerConfig, McpTool } from '../services/mcp/index.js'
import { trustMcpServerLocally } from '../config/settings.js'
import type { MyAgentSettings } from '../config/settings.js'
import type { ToolRegistry } from './toolRegistry.js'
import type { McpConnectionStatus } from './types.js'

export interface ConnectMcpServersOptions {
  cwd: string
  settings: MyAgentSettings
  registry: ToolRegistry
  /** Asked once per untrusted server. Must run before any UI owns stdin. */
  confirmTrust: (name: string, server: McpServerConfig) => Promise<boolean>
  /** Emits the `mcp_connect_failed` metric; also called on reconnect failures. */
  onConnectFailure: (name: string, error: string) => Promise<void>
}

export interface ConnectMcpServersResult {
  clients: ManagedMcpClient[]
  status: McpConnectionStatus
}

/**
 * Connects every configured MCP server and publishes its tools into the
 * registry. Fail-open: a server that cannot be trusted or connected is
 * reported in `status.failed` and never blocks startup.
 */
export async function connectMcpServers(
  options: ConnectMcpServersOptions,
): Promise<ConnectMcpServersResult> {
  const { cwd, settings, registry, confirmTrust, onConnectFailure } = options
  const mcpConfig = await loadMcpConfig(cwd, settings)
  const clients: ManagedMcpClient[] = []
  const status: McpConnectionStatus = { connected: [], failed: [] }
  const trustedServers = new Set(settings.mcp?.trustedServers ?? [])

  const recordFailure = async (name: string, error: string) => {
    status.failed.push({ name, error })
    await onConnectFailure(name, error)
  }

  for (const [name, serverConfig] of Object.entries(mcpConfig)) {
    try {
      if (!trustedServers.has(name)) {
        const trusted = await confirmTrust(name, serverConfig)
        if (!trusted) {
          await recordFailure(name, 'not trusted')
          continue
        }
        await trustMcpServerLocally(cwd, name)
        trustedServers.add(name)
      }

      const timeoutMs = getMcpTimeoutMs(serverConfig)
      let manager: ManagedMcpClient
      manager = await connectManagedMcpServer(serverConfig, {
        onReconnect: async (client) => {
          // List through the fresh client, but invoke through the stable
          // manager wrapper.
          await refreshMcpServerTools(name, client, manager, timeoutMs, registry)
        },
        onToolsChanged: (_client, tools) => {
          setMcpServerTools(name, tools, manager, registry)
        },
        onReconnectFailed: async (error) => {
          await onConnectFailure(name, error.message)
        },
      })
      await refreshMcpServerTools(name, manager, manager, timeoutMs, registry)
      clients.push(manager)
      status.connected.push({ name, toolCount: registry.serverToolCount(name) })
    } catch (error) {
      await recordFailure(name, error instanceof Error ? error.message : String(error))
    }
  }

  return { clients, status }
}

export async function refreshMcpServerTools(
  name: string,
  client: Pick<ManagedMcpClient, 'listTools'>,
  toolClient: ManagedMcpClient,
  timeoutMs: number,
  registry: ToolRegistry,
): Promise<void> {
  const listed = await client.listTools(undefined, { timeout: timeoutMs })
  setMcpServerTools(name, listed.tools, toolClient, registry)
}

export function setMcpServerTools(
  name: string,
  listedTools: Awaited<ReturnType<ManagedMcpClient['listTools']>>['tools'],
  toolClient: ManagedMcpClient,
  registry: ToolRegistry,
): void {
  const mcpTools: McpTool[] = listedTools.map((t) => ({
    name: t.name,
    description: t.description ?? '',
    inputSchema: t.inputSchema,
    annotations: t.annotations as Record<string, unknown> | undefined,
  }))
  registry.setServerTools(name, mcpTools.map((mcpTool) => wrapMcpTool(name, mcpTool, toolClient)))
}
