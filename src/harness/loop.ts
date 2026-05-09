import { randomUUID } from 'node:crypto'
import { ContextBuilder } from './contextBuilder.js'
import { ToolRunner } from './toolRunner.js'
import type { ChatMessage, ModelProvider, SessionRecord, Tool, ToolContext } from './types.js'

export interface AgentLoopOptions {
  provider: ModelProvider
  model: string
  maxTokens?: number
  tools: Tool[]
  contextBuilder: ContextBuilder
  toolRunner: ToolRunner
  toolContext: ToolContext
  system?: string
  loadRecords(): Promise<SessionRecord[]>
  appendRecord(record: SessionRecord): Promise<void>
}

export class AgentLoop {
  constructor(private readonly options: AgentLoopOptions) {}

  async run(userInput: string): Promise<string> {
    const userMessage: ChatMessage & { type: 'message' } = {
      type: 'message',
      id: randomUUID(),
      role: 'user',
      content: userInput,
      createdAt: new Date().toISOString(),
    }
    await this.options.appendRecord(userMessage)

    for (let iteration = 0; iteration < 8; iteration++) {
      const records = await this.options.loadRecords()
      const built = this.options.contextBuilder.build({
        records,
        tools: this.options.tools,
        system: this.options.system,
      })
      const response = await this.options.provider.createMessage({
        system: built.system,
        messages: built.messages,
        contextItems: built.contextItems,
        tools: this.options.tools,
        model: this.options.model,
        maxTokens: this.options.maxTokens,
      })

      const assistantMessage: ChatMessage & { type: 'message' } = {
        type: 'message',
        id: randomUUID(),
        role: 'assistant',
        content: response.content,
        createdAt: new Date().toISOString(),
        model: this.options.model,
      }
      await this.options.appendRecord(assistantMessage)

      if (response.toolCalls.length === 0) {
        return response.content
      }

      for (const toolCall of response.toolCalls) {
        await this.options.toolRunner.run(toolCall, this.options.toolContext)
      }
    }

    throw new Error('Agent loop exceeded maximum tool iterations')
  }
}
