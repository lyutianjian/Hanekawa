export { registerCommand, getCommand, listCommands, hasCommand } from './registry.js'
export type { CommandDefinition, CommandContext, CommandResult } from './types.js'

import { registerCommand } from './registry.js'
import { helpCommand } from './help.js'
import { clearCommand } from './clear.js'
import { costCommand } from './cost.js'
import { modelCommand } from './model.js'
import { sessionCommand } from './session.js'
import { skillsCommand } from './skills.js'
import { compactCommand } from './compact.js'
import { repairCommand } from './repair.js'
import { agentsCommand } from './agents.js'
import { providerCommand } from './provider.js'
import { planCommand } from './plan.js'
import { effortCommand } from './effort.js'
import { tasksCommand } from './tasks.js'
import { resumeCommand } from './resume.js'

// Register all built-in commands
export function registerBuiltinCommands(): void {
  registerCommand(helpCommand)
  registerCommand(clearCommand)
  registerCommand(costCommand)
  registerCommand(modelCommand)
  registerCommand(sessionCommand)
  registerCommand(skillsCommand)
  registerCommand(compactCommand)
  registerCommand(repairCommand)
  registerCommand(agentsCommand)
  registerCommand(providerCommand)
  registerCommand(planCommand)
  registerCommand(effortCommand)
  registerCommand(tasksCommand)
  registerCommand(resumeCommand)
}
