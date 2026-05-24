import type { CommandDefinition } from './types.js'

const commands = new Map<string, CommandDefinition>()

export function registerCommand(def: CommandDefinition): void {
  commands.set(def.name, def)
}

export function getCommand(name: string): CommandDefinition | undefined {
  return commands.get(name)
}

export function listCommands(): CommandDefinition[] {
  return [...commands.values()].filter((c) => c.isEnabled?.() ?? true)
}

export function hasCommand(name: string): boolean {
  return commands.has(name)
}
