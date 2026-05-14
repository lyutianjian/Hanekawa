import type { ChatMessage } from '../components/messages/types.js'

export type SlashCommandResult = {
  handled: boolean
  message?: ChatMessage
}

export function handleSlashCommand(input: string, context: { model?: string }): SlashCommandResult {
  const trimmed = input.trim()

  if (trimmed === '/help') {
    return {
      handled: true,
      message: {
        id: `sys-${Date.now()}`,
        role: 'system',
        content: `Available commands:
  /help    — Show this help
  /clear   — Clear conversation history
  /cost    — Show token usage and cost
  /model   — Show current model
  /compact — Compact conversation history`,
        timestamp: Date.now(),
      },
    }
  }

  if (trimmed === '/model') {
    return {
      handled: true,
      message: {
        id: `sys-${Date.now()}`,
        role: 'system',
        content: `Current model: ${context.model || 'unknown'}`,
        timestamp: Date.now(),
      },
    }
  }

  if (trimmed === '/clear') {
    return { handled: true } // caller handles clearing
  }

  return { handled: false }
}
