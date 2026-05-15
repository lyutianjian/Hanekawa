import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { McpServerConfig } from '../services/mcp/types.js'

export interface MyAgentSettings {
  permissions?: {
    allow?: string[]
    deny?: string[]
    ask?: string[]
  }
  mcpServers?: Record<string, McpServerConfig>
  defaultModel?: string
  autoCompact?: boolean
  autoCompactThreshold?: number
}

async function loadSettingsFile(filePath: string): Promise<MyAgentSettings> {
  let content: string
  try {
    content = await readFile(filePath, 'utf-8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw error
  }
  return JSON.parse(content) as MyAgentSettings
}

function mergeSettings(...sources: MyAgentSettings[]): MyAgentSettings {
  const result: MyAgentSettings = {}

  for (const source of sources) {
    if (source.defaultModel) {
      result.defaultModel = source.defaultModel
    }

    if (source.permissions) {
      result.permissions = {
        allow: [...(result.permissions?.allow ?? []), ...(source.permissions.allow ?? [])],
        deny: [...(result.permissions?.deny ?? []), ...(source.permissions.deny ?? [])],
        ask: [...(result.permissions?.ask ?? []), ...(source.permissions.ask ?? [])],
      }
    }

    if (source.mcpServers) {
      result.mcpServers = { ...result.mcpServers, ...source.mcpServers }
    }

    if (source.autoCompact !== undefined) {
      result.autoCompact = source.autoCompact
    }

    if (source.autoCompactThreshold !== undefined) {
      result.autoCompactThreshold = source.autoCompactThreshold
    }
  }

  return result
}

export async function loadMergedSettings(cwd: string): Promise<MyAgentSettings> {
  const userSettings = await loadSettingsFile(join(homedir(), '.myagent', 'settings.json'))
  const projectSettings = await loadSettingsFile(join(cwd, '.myagent', 'settings.json'))
  const localSettings = await loadSettingsFile(join(cwd, '.myagent', 'settings.local.json'))

  return mergeSettings(userSettings, projectSettings, localSettings)
}

export function validateSettings(settings: MyAgentSettings): { valid: boolean; errors: string[] } {
  const errors: string[] = []

  if (settings.mcpServers) {
    for (const [name, config] of Object.entries(settings.mcpServers)) {
      if (config.transport === 'stdio' && !config.command) {
        errors.push(`MCP server "${name}" with stdio transport requires "command"`)
      }
      if (config.transport === 'sse' && !config.url) {
        errors.push(`MCP server "${name}" with sse transport requires "url"`)
      }
    }
  }

  return { valid: errors.length === 0, errors }
}
