import type { ChatMessage } from '../harness/types.js'
import { ContextBudget } from './budget.js'

export interface ComposerOptions {
  system?: string
  budget: ContextBudget
  includeHistory?: boolean
}

export class PromptComposer {
  compose(
    messages: ChatMessage[],
    options: ComposerOptions,
  ): { system?: string; messages: ChatMessage[] } {
    const { system, budget, includeHistory = true } = options

    if (!includeHistory) {
      return { system, messages: [] }
    }

    const truncatedMessages = budget.truncate(messages, system)
    return { system, messages: truncatedMessages }
  }

  buildRequestMessages(
    messages: ChatMessage[],
    options: ComposerOptions,
  ): { system?: string; messages: ChatMessage[] } {
    return this.compose(messages, options)
  }
}
