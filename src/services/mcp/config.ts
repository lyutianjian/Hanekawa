import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import type { McpServerConfig } from './types.js'

interface McpConfig {
  mcpServers?: Record<string, McpServerConfig>
}

export async function loadMcpConfig(cwd: string): Promise<Record<string, McpServerConfig>> {
  // Try project-level config first
  const projectConfigPath = join(cwd, '.myagent', 'mcp.json')
  if (existsSync(projectConfigPath)) {
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

  return {}
}
