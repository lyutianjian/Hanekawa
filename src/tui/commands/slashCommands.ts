import type { ChatMessage } from '../components/messages/types.js'

export type SlashCommandResult = {
  handled: boolean
  message?: ChatMessage
}

export function handleSlashCommand(input: string, context: { model?: string; sessionId?: string }): SlashCommandResult {
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

  if (trimmed === '/cost') {
    return {
      handled: true,
      message: {
        id: `sys-${Date.now()}`,
        role: 'system',
        content: 'Cost tracking will be displayed here. Use /cost after a conversation to see usage.',
        timestamp: Date.now(),
      },
    }
  }

  if (trimmed === '/session') {
    return {
      handled: true,
      message: {
        id: `sys-${Date.now()}`,
        role: 'system',
        content: `Session: ${context.sessionId || 'unknown'}`,
        timestamp: Date.now(),
      },
    }
  }

  if (trimmed === '/compact') {
    return {
      handled: true,
      message: {
        id: `sys-${Date.now()}`,
        role: 'system',
        content: 'Compacting conversation history...',
        timestamp: Date.now(),
      },
    }
  }

  if (trimmed === '/clear') {
    return { handled: true } // caller handles clearing
  }

  return { handled: false }
}
