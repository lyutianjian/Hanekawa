import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { AgentConfig, ModelConfig } from './service.js'
import type { Endpoint, Profile, Routing } from './routing.js'
import type { EffortLevel } from './effort.js'
import type { HookCommand } from '../harness/hooks.js'
import type { PermissionMode } from '../harness/permissions.js'
import type { McpServerConfig } from '../services/mcp/types.js'

export type HookCommandSetting = HookCommand
export type PreToolUseHookSetting = HookCommandSetting
export type StartupPermissionMode = Exclude<PermissionMode, 'plan'>

const STARTUP_PERMISSION_MODES: readonly StartupPermissionMode[] = ['default', 'acceptEdits', 'bypass']

export interface MyAgentSettings {
  permissions?: {
    mode?: StartupPermissionMode
    allow?: string[]
    deny?: string[]
    ask?: string[]
  }
  hooks?: {
    userPromptSubmit?: HookCommandSetting[]
    preToolUse?: HookCommandSetting[]
    postToolUse?: HookCommandSetting[]
    preCompact?: HookCommandSetting[]
    postCompact?: HookCommandSetting[]
    subagentStart?: HookCommandSetting[]
    subagentStop?: HookCommandSetting[]
    stop?: HookCommandSetting[]
  }
  mcpServers?: Record<string, McpServerConfig>
  mcp?: {
    trustedServers?: string[]
  }
  cache?: {
    ttl1h?: boolean
  }
  models?: Record<string, ModelConfig>
  endpoints?: Record<string, Endpoint>
  profiles?: Record<string, Profile>
  activeProfile?: string
  routing?: Routing
  defaultModel?: string
  fallbackModel?: string
  compactModel?: string
  agent?: AgentConfig
  autoCompact?: boolean
  autoCompactThreshold?: number
  effortLevel?: EffortLevel
}

interface LegacyMcpSettings {
  mcpServers?: Record<string, McpServerConfig>
}

async function loadSettingsFile(filePath: string): Promise<MyAgentSettings> {
  let content: string
  try {
    content = await readFile(filePath, 'utf-8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw error
  }
  try {
    return JSON.parse(content) as MyAgentSettings
  } catch (error) {
    console.error(`[myagent] Warning: corrupted settings file ${filePath}: ${error instanceof Error ? error.message : String(error)}`)
    return {}
  }
}

async function loadLegacyMcpSettings(cwd: string): Promise<MyAgentSettings> {
  let content: string
  const filePath = join(cwd, '.myagent', 'mcp.json')
  try {
    content = await readFile(filePath, 'utf-8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw error
  }

  try {
    const config = JSON.parse(content) as LegacyMcpSettings
    return config.mcpServers ? { mcpServers: config.mcpServers } : {}
  } catch (error) {
    console.error(`[myagent] Warning: corrupted MCP settings file ${filePath}: ${error instanceof Error ? error.message : String(error)}`)
    return {}
  }
}

function mergeSettings(...sources: MyAgentSettings[]): MyAgentSettings {
  const result: MyAgentSettings = {}

  for (const source of sources) {
    if (source.defaultModel !== undefined) {
      result.defaultModel = source.defaultModel
    }

    if (source.fallbackModel !== undefined) {
      result.fallbackModel = source.fallbackModel
    }

    if (source.compactModel !== undefined) {
      result.compactModel = source.compactModel
    }

    if (source.models) {
      result.models = { ...result.models, ...source.models }
    }

    if (source.endpoints) {
      result.endpoints = { ...result.endpoints, ...source.endpoints }
    }

    if (source.profiles) {
      result.profiles = { ...result.profiles, ...source.profiles }
    }

    if (source.activeProfile !== undefined) {
      result.activeProfile = source.activeProfile
    }

    if (source.routing) {
      result.routing = {
        ...result.routing,
        ...source.routing,
        subagent: {
          ...result.routing?.subagent,
          ...source.routing.subagent,
        },
      }
    }

    if (source.agent) {
      result.agent = {
        ...result.agent,
        ...source.agent,
        contextManagement: {
          ...result.agent?.contextManagement,
          ...source.agent.contextManagement,
        },
      }
    }

    if (source.permissions) {
      const mode = source.permissions.mode ?? result.permissions?.mode
      result.permissions = {
        ...(mode !== undefined ? { mode } : {}),
        allow: [...(result.permissions?.allow ?? []), ...(source.permissions.allow ?? [])],
        deny: [...(result.permissions?.deny ?? []), ...(source.permissions.deny ?? [])],
        ask: [...(result.permissions?.ask ?? []), ...(source.permissions.ask ?? [])],
      }
    }

    if (source.hooks) {
      result.hooks = {
        ...result.hooks,
        ...(source.hooks.userPromptSubmit
          ? {
              userPromptSubmit: [
                ...(result.hooks?.userPromptSubmit ?? []),
                ...source.hooks.userPromptSubmit,
              ],
            }
          : {}),
        ...(source.hooks.preToolUse
          ? {
              preToolUse: [
                ...(result.hooks?.preToolUse ?? []),
                ...source.hooks.preToolUse,
              ],
            }
          : {}),
        ...(source.hooks.postToolUse
          ? {
              postToolUse: [
                ...(result.hooks?.postToolUse ?? []),
                ...source.hooks.postToolUse,
              ],
            }
          : {}),
        ...(source.hooks.preCompact
          ? {
              preCompact: [
                ...(result.hooks?.preCompact ?? []),
                ...source.hooks.preCompact,
              ],
            }
          : {}),
        ...(source.hooks.postCompact
          ? {
              postCompact: [
                ...(result.hooks?.postCompact ?? []),
                ...source.hooks.postCompact,
              ],
            }
          : {}),
        ...(source.hooks.subagentStart
          ? {
              subagentStart: [
                ...(result.hooks?.subagentStart ?? []),
                ...source.hooks.subagentStart,
              ],
            }
          : {}),
        ...(source.hooks.subagentStop
          ? {
              subagentStop: [
                ...(result.hooks?.subagentStop ?? []),
                ...source.hooks.subagentStop,
              ],
            }
          : {}),
        ...(source.hooks.stop
          ? {
              stop: [
                ...(result.hooks?.stop ?? []),
                ...source.hooks.stop,
              ],
            }
          : {}),
      }
    }

    if (source.mcpServers) {
      result.mcpServers = { ...result.mcpServers, ...source.mcpServers }
    }

    if (source.mcp) {
      const trustedServers = source.mcp.trustedServers
        ? [...new Set([...(result.mcp?.trustedServers ?? []), ...source.mcp.trustedServers])]
        : result.mcp?.trustedServers
      result.mcp = {
        ...result.mcp,
        ...(trustedServers ? { trustedServers } : {}),
      }
    }

    if (source.cache) {
      result.cache = {
        ...result.cache,
        ...source.cache,
      }
    }

    if (source.autoCompact !== undefined) {
      result.autoCompact = source.autoCompact
    }

    if (source.autoCompactThreshold !== undefined) {
      result.autoCompactThreshold = source.autoCompactThreshold
    }

    if (source.effortLevel !== undefined) {
      result.effortLevel = source.effortLevel
    }

  }

  return result
}

export async function loadMergedSettings(cwd: string): Promise<MyAgentSettings> {
  const userSettings = await loadSettingsFile(join(homedir(), '.myagent', 'settings.json'))
  const projectSettings = await loadSettingsFile(join(cwd, '.myagent', 'settings.json'))
  const legacyMcpSettings = await loadLegacyMcpSettings(cwd)
  const localSettings = await loadSettingsFile(join(cwd, '.myagent', 'settings.local.json'))

  return mergeSettings(userSettings, projectSettings, legacyMcpSettings, localSettings)
}

export async function trustMcpServerLocally(cwd: string, serverName: string): Promise<void> {
  const localSettingsPath = join(cwd, '.myagent', 'settings.local.json')
  const localSettings = await loadSettingsFile(localSettingsPath)
  const trustedServers = new Set(localSettings.mcp?.trustedServers ?? [])
  trustedServers.add(serverName)
  localSettings.mcp = {
    ...localSettings.mcp,
    trustedServers: [...trustedServers].sort(),
  }

  await mkdir(join(cwd, '.myagent'), { recursive: true })
  await writeFile(`${localSettingsPath}.tmp`, `${JSON.stringify(localSettings, null, 2)}\n`, 'utf-8')
  await rename(`${localSettingsPath}.tmp`, localSettingsPath)
}

export async function saveEffortLevel(level: EffortLevel): Promise<void> {
  const settingsPath = join(homedir(), '.myagent', 'settings.json')
  const settings = await loadSettingsFile(settingsPath)
  settings.effortLevel = level
  await mkdir(join(homedir(), '.myagent'), { recursive: true })
  await writeFile(`${settingsPath}.tmp`, `${JSON.stringify(settings, null, 2)}\n`, 'utf-8')
  await rename(`${settingsPath}.tmp`, settingsPath)
}

export function validateSettings(settings: MyAgentSettings): { valid: boolean; errors: string[] } {
  const errors: string[] = []

  if (settings.models) {
    for (const [name, model] of Object.entries(settings.models)) {
      if (!model || typeof model !== 'object') {
        errors.push(`models.${name} must be an object`)
        continue
      }
      if (typeof model.provider !== 'string' || model.provider.trim() === '') {
        if (typeof model.endpoint !== 'string' || model.endpoint.trim() === '') {
          errors.push(`models.${name}.provider must be a non-empty string when endpoint is not set`)
        }
      }
      if (typeof model.model !== 'string' || model.model.trim() === '') {
        errors.push(`models.${name}.model must be a non-empty string`)
      }
      if (model.contextWindow !== undefined && (!Number.isInteger(model.contextWindow) || model.contextWindow < 1)) {
        errors.push(`models.${name}.contextWindow must be a positive integer`)
      }
    }
  }

  if (settings.defaultModel !== undefined && (typeof settings.defaultModel !== 'string' || settings.defaultModel.trim() === '')) {
    errors.push('defaultModel must be a non-empty string')
  }

  if (settings.fallbackModel !== undefined && (typeof settings.fallbackModel !== 'string' || settings.fallbackModel.trim() === '')) {
    errors.push('fallbackModel must be a non-empty string')
  }

  if (settings.compactModel !== undefined && (typeof settings.compactModel !== 'string' || settings.compactModel.trim() === '')) {
    errors.push('compactModel must be a non-empty string')
  }

  if (settings.agent?.system !== undefined && typeof settings.agent.system !== 'string') {
    errors.push('agent.system must be a string')
  }

  if (settings.agent?.agentTimeoutMs !== undefined && (!Number.isInteger(settings.agent.agentTimeoutMs) || settings.agent.agentTimeoutMs < 1)) {
    errors.push('agent.agentTimeoutMs must be a positive integer')
  }

  if (settings.mcpServers) {
    for (const [name, config] of Object.entries(settings.mcpServers)) {
      if (config.transport === 'stdio' && !config.command) {
        errors.push(`MCP server "${name}" with stdio transport requires "command"`)
      }
      if (config.transport === 'sse' && !config.url) {
        errors.push(`MCP server "${name}" with sse transport requires "url"`)
      }
      if (config.args !== undefined && !Array.isArray(config.args)) {
        errors.push(`MCP server "${name}" args must be an array of strings`)
      } else if (config.args?.some((arg) => typeof arg !== 'string')) {
        errors.push(`MCP server "${name}" args must be an array of strings`)
      }
      if (config.timeoutMs !== undefined && (!Number.isInteger(config.timeoutMs) || config.timeoutMs < 1)) {
        errors.push(`MCP server "${name}" timeoutMs must be a positive integer`)
      }
    }
  }

  if (settings.mcp?.trustedServers !== undefined) {
    if (!Array.isArray(settings.mcp.trustedServers)) {
      errors.push('mcp.trustedServers must be an array of strings')
    } else if (settings.mcp.trustedServers.some((server) => typeof server !== 'string' || server.trim() === '')) {
      errors.push('mcp.trustedServers must be an array of non-empty strings')
    }
  }

  if (settings.cache?.ttl1h !== undefined && typeof settings.cache.ttl1h !== 'boolean') {
    errors.push('cache.ttl1h must be a boolean')
  }

  if (settings.effortLevel !== undefined && !['low', 'medium', 'high', 'xhigh', 'max'].includes(settings.effortLevel)) {
    errors.push('effortLevel must be one of: low, medium, high, xhigh, max')
  }

  if (settings.permissions?.mode !== undefined && !STARTUP_PERMISSION_MODES.includes(settings.permissions.mode as StartupPermissionMode)) {
    errors.push('permissions.mode must be one of: default, acceptEdits, auto, bypass')
  }

  for (const name of ['allow', 'deny', 'ask'] as const) {
    const rules = settings.permissions?.[name]
    if (rules !== undefined && !Array.isArray(rules)) {
      errors.push(`permissions.${name} must be an array`)
      continue
    }
    if (rules?.some((rule) => typeof rule !== 'string' || rule.trim() === '')) {
      errors.push(`permissions.${name} must be an array of non-empty strings`)
    }
  }

  for (const name of ['userPromptSubmit', 'preToolUse', 'postToolUse', 'preCompact', 'postCompact', 'subagentStart', 'subagentStop', 'stop'] as const) {
    const hooks = settings.hooks?.[name]
    if (hooks !== undefined && !Array.isArray(hooks)) {
      errors.push(`hooks.${name} must be an array`)
      continue
    }
    for (const [index, hook] of (hooks ?? []).entries()) {
      validateHookSetting(hook, `hooks.${name}[${index}]`, errors)
    }
  }

  return { valid: errors.length === 0, errors }
}

function validateHookSetting(hook: HookCommandSetting, path: string, errors: string[]): void {
  if (!hook || typeof hook !== 'object') {
    errors.push(`${path} must be an object`)
    return
  }
  if (typeof hook.command !== 'string' || hook.command.trim() === '') {
    errors.push(`${path}.command must be a non-empty string`)
  }
  if (hook.matcher !== undefined && typeof hook.matcher !== 'string') {
    errors.push(`${path}.matcher must be a string`)
  }
  if (hook.timeoutMs !== undefined && (!Number.isInteger(hook.timeoutMs) || hook.timeoutMs < 1)) {
    errors.push(`${path}.timeoutMs must be a positive integer`)
  }
}
