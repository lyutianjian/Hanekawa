import readline from 'node:readline'
import type { Tool } from '../harness/types.js'

interface Session {
  messages: Array<{ role: string; content: Array<{ type: string; text: string }> }>
  tools: Tool[]
}

export type CommandResult =
  | { type: 'continue' }
  | { type: 'exit' }
  | { type: 'message'; text: string }

export function handleCommand(input: string, session: Session): CommandResult {
  const trimmed = input.trim()

  if (trimmed === '/exit' || trimmed === '/quit') {
    return { type: 'exit' }
  }

  if (trimmed === '/clear') {
    session.messages = []
    console.log('Conversation cleared.')
    return { type: 'continue' }
  }

  if (trimmed === '/help') {
    console.log(`
Available commands:
  /help           Show this help message
  /clear          Clear conversation history
  /skills list    List all available skills
  /exit, /quit    Exit the CLI
    `.trim())
    return { type: 'continue' }
  }

  if (trimmed === '/skills list') {
    const skillTools = session.tools.filter((t: Tool) => t.name.startsWith('skill_'))
    if (skillTools.length === 0) {
      console.log('No skills available.')
    } else {
      console.log(`\nAvailable skills (${skillTools.length}):`)
      for (const tool of skillTools) {
        const skillName = tool.name.replace(/^skill_/, '')
        console.log(`  ${skillName} - ${tool.description}`)
      }
    }
    return { type: 'continue' }
  }

  // Unknown command
  console.log(`Unknown command: ${trimmed}. Type /help for available commands.`)
  return { type: 'continue' }
}
