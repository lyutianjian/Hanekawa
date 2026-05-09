import type { ChatMessage } from '../harness/types.js'

export interface TokenCount {
  total: number
  messages: number[]
}

function countTokens(text: string): number {
  // Rough estimate: ~4 chars per token for English, more for CJK
  // This is a simplified approximation for the MVP
  let count = 0
  for (const char of text) {
    if (char.charCodeAt(0) > 127) {
      count += 2 // CJK characters
    } else {
      count += 0.25 // English/ASCII
    }
  }
  return Math.ceil(count)
}

export function countMessageTokens(message: ChatMessage): number {
  return countTokens(message.content)
}

export function countMessagesTokens(messages: ChatMessage[]): TokenCount {
  const counts = messages.map(countMessageTokens)
  return {
    total: counts.reduce((a, b) => a + b, 0),
    messages: counts,
  }
}

export class ContextBudget {
  private budget: number

  constructor(budget: number = 100_000) {
    this.budget = budget
  }

  getBudget(): number {
    return this.budget
  }

  setBudget(budget: number): void {
    this.budget = budget
  }

  truncate(messages: ChatMessage[], system?: string): ChatMessage[] {
    const systemTokens = system ? countTokens(system) : 0
    const availableBudget = this.budget - systemTokens - 1000 // Reserve for response

    if (availableBudget <= 0) {
      return []
    }

    const result: ChatMessage[] = []
    let used = 0

    // Add messages from oldest to newest until budget is exhausted
    for (const message of messages) {
      const tokens = countMessageTokens(message)
      if (used + tokens > availableBudget) {
        break
      }
      result.push(message)
      used += tokens
    }

    return result
  }

  estimate(messages: ChatMessage[], system?: string): { used: number; budget: number; remaining: number } {
    const used = countMessagesTokens(messages).total + (system ? countTokens(system) : 0)
    return {
      used,
      budget: this.budget,
      remaining: Math.max(0, this.budget - used),
    }
  }
}
