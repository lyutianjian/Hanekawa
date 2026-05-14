import type { ChatMessage } from '../components/messages/types.js'

export type SlashCommandResult = {
  handled: boolean
  message?: ChatMessage
  action?: string
  model?: string
}

export function handleSlashCommand(input: string, context: {
  model?: string
  sessionId?: string
  messageCount?: number
  createdAt?: string
}): SlashCommandResult {
  const trimmed = input.trim()

  if (trimmed === '/help') {
    return {
      handled: true,
      message: {
        id: `sys-${Date.now()}`,
        role: 'system',
        content: `Available commands:
  /help     — Show this help
  /clear    — Clear conversation history
  /cost     — Show token usage and cost
  /model    — Show current model
  /session  — Show session info
  /compact  — Compact conversation history
  /settings — Open settings screen`,
        timestamp: Date.now(),
      },
    }
  }

  if (trimmed.startsWith('/model')) {
    const parts = trimmed.split(/\s+/)
    if (parts.length > 1) {
      const newModel = parts.slice(1).join(' ')
      return {
        handled: true,
        message: {
          id: `sys-${Date.now()}`,
          role: 'system',
          content: `Model switch requested: ${newModel}\nNote: Model switching will take effect on the next conversation turn.`,
          timestamp: Date.now(),
        },
        action: 'switch_model',
        model: newModel,
      }
    }
    return {
      handled: true,
      message: {
        id: `sys-${Date.now()}`,
        role: 'system',
        content: `Current model: ${context.model || 'unknown'}\nUse /model <name> to switch.`,
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
    const lines = [
      `Session ID: ${context.sessionId || 'unknown'}`,
      context.messageCount !== undefined ? `Messages: ${context.messageCount}` : null,
      context.createdAt ? `Created: ${context.createdAt}` : null,
    ].filter(Boolean).join('\n')

    return {
      handled: true,
      message: {
        id: `sys-${Date.now()}`,
        role: 'system',
        content: lines,
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

  if (trimmed === '/settings') {
    return {
      handled: true,
      action: 'open_settings',
    }
  }

  if (trimmed === '/clear') {
    return { handled: true } // caller handles clearing
  }

  return { handled: false }
}
