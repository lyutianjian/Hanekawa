import type { CommandDefinition } from './types.js'

/**
 * The slash commands available in one project.
 *
 * An instance rather than a module-level `Map`: skill commands are read from
 * `<cwd>/.myagent/skills/`, so a shared registry means the second project
 * bootstrapped in a process either leaks its skills into the first or is
 * refused as a duplicate name. `ProjectRuntime` owns one, alongside
 * `ToolRegistry` and `BackgroundTaskRegistry` — everything a `cwd` has exactly
 * one of.
 */
export class CommandRegistry {
  private readonly commands = new Map<string, CommandDefinition>()

  register(def: CommandDefinition): void {
    this.commands.set(def.name, def)
  }

  get(name: string): CommandDefinition | undefined {
    return this.commands.get(name)
      ?? [...this.commands.values()].find((c) => c.aliases?.includes(name))
  }

  /** Filtered for display: what a `/` menu or `/help` should show. */
  list(): CommandDefinition[] {
    return [...this.commands.values()].filter((c) => (c.isEnabled?.() ?? true) && !c.isHidden)
  }

  has(name: string): boolean {
    return this.get(name) !== undefined
  }
}
