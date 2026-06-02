import type { CommandDefinition } from './types.js'

const commands = new Map<string, CommandDefinition>()

export function registerCommand(def: CommandDefinition): void {
  commands.set(def.name, def)
}

export function getCommand(name: string): CommandDefinition | undefined {
  return commands.get(name) ?? [...commands.values()].find((c) => c.aliases?.includes(name))
}

export function listCommands(): CommandDefinition[] {
  return [...commands.values()].filter((c) => (c.isEnabled?.() ?? true) && !c.isHidden)
}

export function hasCommand(name: string): boolean {
  return getCommand(name) !== undefined
}
