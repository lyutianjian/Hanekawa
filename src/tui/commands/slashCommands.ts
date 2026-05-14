import type { ChatMessage } from '../components/messages/types.js'

export type SlashCommandResult = {
  handled: boolean
  message?: ChatMessage
  action?: string
  model?: string
  theme?: 'dark' | 'light' | 'auto'
  sessionId?: string
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
  /sessions — List all sessions
  /switch   — Switch to session
  /retry    — Retry the last user message
  /compact  — Compact conversation history
  /settings — Open settings screen
  /doctor   — Run system diagnostics
  /theme    — Switch theme (dark/light/auto)
  /verbose  — Toggle verbose mode
  /export   — Export conversation to JSON`,
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
      action: 'show_cost',
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

  if (trimmed === '/doctor') {
    return {
      handled: true,
      action: 'open_doctor',
    }
  }

  if (trimmed === '/retry') {
    return {
      handled: true,
      action: 'retry',
    }
  }

  if (trimmed === '/clear') {
    return { handled: true } // caller handles clearing
  }

  if (trimmed.startsWith('/theme')) {
    const parts = trimmed.split(/\s+/)
    const theme = parts[1]
    if (theme && ['dark', 'light', 'auto'].includes(theme)) {
      return {
        handled: true,
        action: 'set_theme',
        theme: theme as 'dark' | 'light' | 'auto',
      }
    }
    return {
      handled: true,
      message: {
        id: `sys-${Date.now()}`,
        role: 'system',
        content: 'Usage: /theme <dark|light|auto>',
        timestamp: Date.now(),
      },
    }
  }

  if (trimmed === '/verbose') {
    return {
      handled: true,
      action: 'toggle_verbose',
    }
  }

  if (trimmed === '/export') {
    return {
      handled: true,
      action: 'export',
    }
  }

  if (trimmed === '/sessions') {
    return {
      handled: true,
      action: 'list_sessions',
    }
  }

  if (trimmed.startsWith('/switch')) {
    const parts = trimmed.split(/\s+/)
    const sessionId = parts[1]
    if (sessionId) {
      return {
        handled: true,
        action: 'switch_session',
        sessionId,
      }
    }
    return {
      handled: true,
      message: {
        id: `sys-${Date.now()}`,
        role: 'system',
        content: 'Usage: /switch <session-id>',
        timestamp: Date.now(),
      },
    }
  }

  return { handled: false }
}
