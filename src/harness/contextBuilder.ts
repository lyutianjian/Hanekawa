import type { ChatMessage, ModelContextItem, SessionRecord, Tool } from './types.js'
import { PromptComposer } from '../prompts/composer.js'
import { ContextBudget } from '../prompts/budget.js'

export interface BuildContextInput {
  records: SessionRecord[]
  tools: Tool[]
  system?: string
  budget?: ContextBudget
}

export interface BuiltContext {
  system?: string
  messages: ChatMessage[]
  contextItems: ModelContextItem[]
}

export class ContextBuilder {
  constructor(
    private readonly composer = new PromptComposer(),
    private readonly defaultBudget = new ContextBudget(),
  ) {}

  build(input: BuildContextInput): BuiltContext {
    const messages = input.records
      .filter((record): record is SessionRecord & { type: 'message' } => record.type === 'message')
      .map((record) => ({
        id: record.id,
        role: record.role,
        content: record.content,
        createdAt: record.createdAt,
        model: record.model,
      }))

    const builtMessages = this.composer.compose(messages, {
      system: input.system,
      budget: input.budget ?? this.defaultBudget,
      includeHistory: true,
    })

    const includedMessageIds = new Set(builtMessages.messages.map((message) => message.id))
    const contextItems: ModelContextItem[] = []

    for (const record of input.records) {
      if (record.type === 'message') {
        if (includedMessageIds.has(record.id)) {
          contextItems.push({
            kind: 'message',
            message: {
              id: record.id,
              role: record.role,
              content: record.content,
              createdAt: record.createdAt,
              model: record.model,
            },
          })
        }
        continue
      }

      if (record.type === 'tool_use') {
        contextItems.push({
          kind: 'tool_use',
          id: record.id,
          tool: record.tool,
          input: record.input,
        })
        continue
      }

      if (record.type === 'tool_result') {
        contextItems.push({
          kind: 'tool_result',
          toolUseId: record.toolUseId,
          tool: record.tool,
          ok: record.ok,
          content: record.content,
        })
      }
    }

    return {
      system: builtMessages.system,
      messages: builtMessages.messages,
      contextItems,
    }
  }
}
