import Fuse, { type FuseResult } from 'fuse.js'
import type { CommandDefinition } from '../../commands/types.js'
import type { SuggestionItem } from './types.js'

export type CommandSuggestion = SuggestionItem<CommandDefinition> & {
  metadata: CommandDefinition
}

interface CommandSearchItem {
  name: string
  aliases: string[]
  description: string
  command: CommandDefinition
}

const fuseCache = new WeakMap<CommandDefinition[], Fuse<CommandSearchItem>>()

function getCommandFuse(commands: CommandDefinition[]): Fuse<CommandSearchItem> {
  const cached = fuseCache.get(commands)
  if (cached) return cached

  const data = commands.map((command) => ({
    name: command.name,
    aliases: command.aliases ?? [],
    description: command.description,
    command,
  }))

  const fuse = new Fuse(data, {
    includeScore: true,
    threshold: 0.35,
    location: 0,
    distance: 100,
    keys: [
      { name: 'name', weight: 3 },
      { name: 'aliases', weight: 2 },
      { name: 'description', weight: 0.5 },
    ],
  })

  fuseCache.set(commands, fuse)
  return fuse
}

export function isCommandInput(input: string): boolean {
  return input.startsWith('/')
}

export function hasCommandArgs(input: string): boolean {
  if (!isCommandInput(input)) return false
  const spaceIndex = input.indexOf(' ')
  if (spaceIndex < 0) return false
  return input.slice(spaceIndex + 1).trim().length > 0
}

export function createCommandSuggestion(command: CommandDefinition): CommandSuggestion {
  return {
    id: command.name,
    displayText: `/${command.name}`,
    description: command.description,
    metadata: command,
  }
}

export function generateCommandSuggestions(
  input: string,
  commands: CommandDefinition[],
): CommandSuggestion[] {
  if (!isCommandInput(input) || hasCommandArgs(input)) return []

  const query = input.slice(1).trim().toLowerCase()
  const visibleCommands = commands.filter((command) => !command.isHidden && (command.isEnabled?.() ?? true))

  if (query === '') {
    return [...visibleCommands]
      .sort((a: CommandDefinition, b: CommandDefinition) => a.name.localeCompare(b.name))
      .map(createCommandSuggestion)
  }

  const fuse = getCommandFuse(visibleCommands)
  return [...fuse.search(query)]
    .sort((a: FuseResult<CommandSearchItem>, b: FuseResult<CommandSearchItem>) => (
      compareCommandMatches(query, a, b)
    ))
    .map((result: FuseResult<CommandSearchItem>) => createCommandSuggestion(result.item.command))
}

export function applyCommandSuggestion(suggestion: CommandSuggestion): {
  text: string
  cursorPos: number
} {
  const command = suggestion.metadata
  const text = `/${command.name} `
  return { text, cursorPos: text.length }
}

function compareCommandMatches(
  query: string,
  a: FuseResult<CommandSearchItem>,
  b: FuseResult<CommandSearchItem>,
): number {
  const aRank = matchRank(query, a.item)
  const bRank = matchRank(query, b.item)
  if (aRank !== bRank) return aRank - bRank

  if (aRank <= 3 && a.item.name.length !== b.item.name.length) {
    return a.item.name.length - b.item.name.length
  }

  return (a.score ?? 0) - (b.score ?? 0)
}

function matchRank(query: string, item: CommandSearchItem): number {
  const name = item.name.toLowerCase()
  const aliases = item.aliases.map((alias) => alias.toLowerCase())

  if (name === query) return 0
  if (aliases.some((alias) => alias === query)) return 1
  if (name.startsWith(query)) return 2
  if (aliases.some((alias) => alias.startsWith(query))) return 3
  return 4
}
