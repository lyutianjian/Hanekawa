import type { ChatMessage, ModelContextItem } from '../harness/types.js'
import {
  selectContextItemsForContext,
  selectMessagesForContext,
  type ContextManagementConfig,
} from './budget.js'

export interface ComposerOptions {
  system?: string
  contextManagement?: Partial<ContextManagementConfig>
  includeHistory?: boolean
}

export class PromptComposer {
  compose(
    messages: ChatMessage[],
    options: ComposerOptions,
  ): { system?: string; messages: ChatMessage[] } {
    const { system, contextManagement, includeHistory = true } = options

    if (!includeHistory) {
      return { system, messages: [] }
    }

    const truncatedMessages = selectMessagesForContext(messages, contextManagement, system)
    return { system, messages: truncatedMessages }
  }

  buildRequestMessages(
    messages: ChatMessage[],
    options: ComposerOptions,
  ): { system?: string; messages: ChatMessage[] } {
    return this.compose(messages, options)
  }

  composeContextItems(
    items: ModelContextItem[],
    options: ComposerOptions,
  ): { system?: string; contextItems: ModelContextItem[]; messages: ChatMessage[] } {
    const { system, contextManagement, includeHistory = true } = options

    if (!includeHistory) {
      return { system, contextItems: [], messages: [] }
    }

    const contextItems = selectContextItemsForContext(items, contextManagement, system)
    const messages = contextItems
      .filter((item): item is ModelContextItem & { kind: 'message' } => item.kind === 'message')
      .map((item) => item.message)

    return { system, contextItems, messages }
  }
}
