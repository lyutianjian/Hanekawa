import { promises as fs } from 'fs'
import path from 'path'
import { listCommands } from '../../commands/registry.js'
import { getBuiltinTools } from '../../tools/index.js'

export interface Suggestion {
  label: string
  description: string
  value: string
  type: 'command' | 'file' | 'tool' | 'model' | 'skill' | 'variable'
}

const fileCache = new Map<string, { entries: any[]; timestamp: number }>()
const CACHE_TTL = 5000

function getCommandSuggestions(input: string): Suggestion[] {
  const commands = listCommands()
  const query = input.slice(1).toLowerCase()

  return commands
    .filter(cmd => cmd.name.toLowerCase().startsWith(query))
    .map(cmd => ({
      label: `/${cmd.name}`,
      description: cmd.description,
      value: `/${cmd.name}`,
      type: 'command' as const,
    }))
}

async function getFileSuggestions(input: string, cwd: string): Promise<Suggestion[]> {
  const match = input.match(/@([\w./-]*)$/)
  if (!match) return []

  const query = match[1]
  const dir = path.dirname(query) || '.'
  const prefix = path.basename(query)

  try {
    const resolvedDir = path.resolve(cwd, dir)

    const cached = fileCache.get(resolvedDir)
    let entries: any[]

    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      entries = cached.entries
    } else {
      entries = await fs.readdir(resolvedDir, { withFileTypes: true })
      fileCache.set(resolvedDir, { entries, timestamp: Date.now() })
    }

    return entries
      .filter((entry: any) => entry.name.startsWith(prefix))
      .slice(0, 10)
      .map((entry: any) => ({
        label: entry.isDirectory() ? `${entry.name}/` : entry.name,
        description: entry.isDirectory() ? 'Directory' : 'File',
        value: `@${path.join(dir, entry.name)}`,
        type: 'file' as const,
      }))
  } catch {
    return []
  }
}

function getToolSuggestions(input: string): Suggestion[] {
  const match = input.match(/\/(\w*)$/)
  if (!match) return []

  const query = match[1].toLowerCase()
  const tools = getBuiltinTools()

  return tools
    .filter(tool => tool.name.toLowerCase().startsWith(query))
    .map(tool => ({
      label: tool.name,
      description: tool.description,
      value: tool.name,
      type: 'tool' as const,
    }))
}

function getModelSuggestions(input: string): Suggestion[] {
  const match = input.match(/model\s+(\w*)$/i)
  if (!match) return []

  const query = match[1].toLowerCase()
  const models = [
    'claude-3-opus',
    'claude-3-sonnet',
    'claude-3-haiku',
    'gpt-4',
    'gpt-3.5-turbo',
  ]

  return models
    .filter(model => model.toLowerCase().startsWith(query))
    .map(model => ({
      label: model,
      description: `Switch to ${model}`,
      value: model,
      type: 'model' as const,
    }))
}

function getVariableSuggestions(input: string): Suggestion[] {
  const match = input.match(/\$(\w*)$/)
  if (!match) return []

  const query = match[1].toUpperCase()
  const variables = Object.keys(process.env)

  return variables
    .filter(variable => variable.startsWith(query))
    .slice(0, 10)
    .map(variable => ({
      label: `$${variable}`,
      description: process.env[variable]?.slice(0, 50) ?? '',
      value: `$${variable}`,
      type: 'variable' as const,
    }))
}

export async function getSuggestions(input: string, cwd: string): Promise<Suggestion[]> {
  if (input.startsWith('/')) {
    return getCommandSuggestions(input)
  }

  if (input.includes('@')) {
    const fileSuggestions = await getFileSuggestions(input, cwd)
    if (fileSuggestions.length > 0) return fileSuggestions
  }

  if (input.match(/model\s+\w*$/i)) {
    return getModelSuggestions(input)
  }

  if (input.includes('$')) {
    return getVariableSuggestions(input)
  }

  return []
}
