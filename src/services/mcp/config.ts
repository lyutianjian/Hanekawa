import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { MyAgentSettings } from '../../config/settings.js'
import type { McpServerConfig } from './types.js'

interface McpConfig {
  mcpServers?: Record<string, McpServerConfig>
}

export async function loadMcpConfig(cwd: string, settings?: MyAgentSettings): Promise<Record<string, McpServerConfig>> {
  if (settings) return { ...(settings.mcpServers ?? {}) }

  // Legacy fallback for callers that have not loaded merged settings yet.
  const projectConfigPath = join(cwd, '.myagent', 'mcp.json')
  try {
    const content = await readFile(projectConfigPath, 'utf-8')
    const config = JSON.parse(content) as McpConfig
    return config.mcpServers ?? {}
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    console.warn(`Failed to parse MCP config at ${projectConfigPath}:`, (error as Error).message)
    return {}
  }
}
