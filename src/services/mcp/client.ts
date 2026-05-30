import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { CallToolRequest, ListToolsRequest } from '@modelcontextprotocol/sdk/types.js'
import type { McpServerConfig } from './types.js'

const DEFAULT_MCP_TIMEOUT_MS = 60_000
const DEFAULT_RECONNECT_ATTEMPTS = 5
const DEFAULT_RECONNECT_BASE_DELAY_MS = 500
const DEFAULT_RECONNECT_MAX_DELAY_MS = 8_000
type ListedMcpTool = Awaited<ReturnType<Client['listTools']>>['tools'][number]

export interface ManagedMcpClientOptions {
  onClose?(): void
  onReconnect?(client: Client): Promise<void> | void
  onReconnectFailed?(error: Error): Promise<void> | void
  onToolsChanged?(client: Client, tools: ListedMcpTool[]): Promise<void> | void
  reconnectAttempts?: number
  reconnectBaseDelayMs?: number
  reconnectMaxDelayMs?: number
}

export interface McpToolClient {
  callTool: Client['callTool']
}

export function getMcpTimeoutMs(config: McpServerConfig): number {
  if (config.timeoutMs === undefined) return DEFAULT_MCP_TIMEOUT_MS
  if (!Number.isInteger(config.timeoutMs) || config.timeoutMs < 1) {
    throw new Error('"timeoutMs" must be a positive integer')
  }
  return config.timeoutMs
}

export async function connectMcpServer(config: McpServerConfig, options: ManagedMcpClientOptions = {}): Promise<Client> {
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

    const client = new Client({ name: 'myagent', version: '0.1.0' }, {
      listChanged: options.onToolsChanged
        ? {
            tools: {
              autoRefresh: true,
              debounceMs: 100,
              onChanged: (error, tools) => {
                if (error) {
                  void options.onReconnectFailed?.(error)
                  return
                }
                if (tools) void options.onToolsChanged?.(client, tools)
              },
            },
          }
        : undefined,
    })
    client.onclose = () => {
      options.onClose?.()
    }
    try {
      await client.connect(transport, { timeout: timeoutMs })
    } catch (error) {
      client.onclose = undefined
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

export class ManagedMcpClient implements McpToolClient {
  private client: Client | undefined
  private reconnecting: Promise<Client> | undefined
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined
  private intentionalClose = false

  constructor(
    private readonly config: McpServerConfig,
    private readonly options: ManagedMcpClientOptions = {},
  ) {}

  async connect(): Promise<Client> {
    if (this.client) return this.client
    const client = await this.connectFresh()
    this.client = client
    return client
  }

  async close(): Promise<void> {
    this.intentionalClose = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = undefined
    }
    // Close the current client if it exists.
    const currentClient = this.client
    this.client = undefined
    if (currentClient) {
      currentClient.onclose = undefined
      await currentClient.close().catch(() => {})
    }
    // If a reconnection is in progress, wait for it to finish and close
    // the newly created client too.
    if (this.reconnecting) {
      try {
        const newClient = await this.reconnecting
        newClient.onclose = undefined
        await newClient.close().catch(() => {})
      } catch {
        // reconnection failed — nothing to close
      }
    }
  }

  async callTool(
    params: CallToolRequest['params'],
    resultSchema?: Parameters<Client['callTool']>[1],
    options?: Parameters<Client['callTool']>[2],
  ): ReturnType<Client['callTool']> {
    try {
      return await this.getClient().then((client) => client.callTool(params, resultSchema, options))
    } catch (error) {
      if (!isMcpSessionExpiredError(error)) throw error
      const client = await this.reconnectNow()
      return client.callTool(params, resultSchema, options)
    }
  }

  async listTools(
    params?: ListToolsRequest['params'],
    options?: Parameters<Client['listTools']>[1],
  ): ReturnType<Client['listTools']> {
    return this.getClient().then((client) => client.listTools(params, options))
  }

  private async getClient(): Promise<Client> {
    if (this.client) return this.client
    return this.reconnectNow()
  }

  private async reconnectNow(): Promise<Client> {
    if (this.reconnecting) return this.reconnecting
    this.reconnecting = (async () => {
      if (this.intentionalClose) {
        throw new Error('Cannot reconnect: client was intentionally closed')
      }
      const staleClient = this.client
      this.client = undefined
      if (staleClient) {
        staleClient.onclose = undefined
        await staleClient.close().catch(() => {})
      }
      const client = await this.connectFresh()
      this.client = client
      await this.options.onReconnect?.(client)
      return client
    })()
      .finally(() => {
        this.reconnecting = undefined
      })
    return this.reconnecting
  }

  private async connectFresh(): Promise<Client> {
    this.intentionalClose = false
    return connectMcpServer(this.config, {
      ...this.options,
      onClose: () => {
        this.client = undefined
        this.options.onClose?.()
        if (!this.intentionalClose) this.scheduleReconnect()
      },
    })
  }

  private scheduleReconnect(attempt = 1): void {
    if (this.intentionalClose || this.reconnecting || this.reconnectTimer) return
    const maxAttempts = this.options.reconnectAttempts ?? DEFAULT_RECONNECT_ATTEMPTS
    if (attempt > maxAttempts) return

    const baseDelay = this.options.reconnectBaseDelayMs ?? DEFAULT_RECONNECT_BASE_DELAY_MS
    const maxDelay = this.options.reconnectMaxDelayMs ?? DEFAULT_RECONNECT_MAX_DELAY_MS
    const delay = Math.min(maxDelay, baseDelay * 2 ** (attempt - 1))
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      void this.reconnectNow().catch((error: unknown) => {
        const normalized = error instanceof Error ? error : new Error(String(error))
        void this.options.onReconnectFailed?.(normalized)
        this.scheduleReconnect(attempt + 1)
      })
    }, delay)
  }
}

export async function connectManagedMcpServer(
  config: McpServerConfig,
  options: ManagedMcpClientOptions = {},
): Promise<ManagedMcpClient> {
  const manager = new ManagedMcpClient(config, options)
  await manager.connect()
  return manager
}

export function isMcpSessionExpiredError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const record = error as Record<string, unknown>
  const code = record.code
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase()

  // Match MCP session-level errors that are transient and recoverable by
  // reconnecting. Deliberately do NOT match generic 'unauthorized' (401)
  // which indicates a credentials problem that reconnecting won't fix.
  return code === -32000
    || (code === -32001 && message.includes('session'))
    || message.includes('connection closed')
    || message.includes('session not found')
    || message.includes('session expired')
    || message.includes('mcp-session-id')
}
