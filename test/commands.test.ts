import test from 'node:test'
import assert from 'node:assert/strict'
import { clearCommand } from '../src/commands/clear.js'
import { compactCommand } from '../src/commands/compact.js'
import { costCommand } from '../src/commands/cost.js'
import { modelCommand } from '../src/commands/model.js'
import type { CommandContext } from '../src/commands/types.js'

function createContext(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    cwd: '/tmp/project',
    sessionId: 'session-1',
    writeLine: () => {},
    clearMessages: () => {},
    ...overrides,
  }
}

test('/cost reports injected usage and real cost', async () => {
  let output = ''
  await costCommand.run('', createContext({
    writeLine: (message) => {
      output = message
    },
    getUsage: () => ({
      cacheReadInputTokens: 100_000,
      inputTokens: 200_000,
      outputTokens: 50_000,
      cost: 0.31,
      currency: 'CNY',
    }),
  }))

  assert.match(output, /Cache read:\s+100,000/)
  assert.match(output, /Input tokens:\s+200,000/)
  assert.match(output, /Output tokens:\s+50,000/)
  assert.match(output, /Total cost:\s+CNY 0\.31/)
})

test('/cost does not report fake cost without pricing', async () => {
  let output = ''
  await costCommand.run('', createContext({
    writeLine: (message) => {
      output = message
    },
    getUsage: () => ({
      cacheReadInputTokens: 0,
      inputTokens: 10,
      outputTokens: 20,
    }),
  }))

  assert.match(output, /Total cost:\s+unavailable \(missing pricing\)/)
  assert.doesNotMatch(output, /\$0\.0000/)
})

test('/model without args shows current model key and provider model id', async () => {
  let output = ''
  await modelCommand.run('', createContext({
    writeLine: (message) => {
      output = message
    },
    getModel: () => ({
      key: 'claude',
      providerName: 'anthropic',
      model: 'claude-sonnet-4-20250514',
    }),
  }))

  assert.match(output, /Name:\s+claude/)
  assert.match(output, /Provider:\s+anthropic/)
  assert.match(output, /Model ID:\s+claude-sonnet-4-20250514/)
})

test('/model with args delegates model switching', async () => {
  let requestedModel = ''
  let output = ''
  let cleared = false
  await modelCommand.run('openai-compatible', createContext({
    writeLine: (message) => {
      output = message
    },
    clearCachedSections: () => {
      cleared = true
    },
    setModel: (model) => {
      requestedModel = model
      return {
        ok: true,
        model: {
          key: model,
          providerName: 'openai',
          model: 'deepseek-chat',
        },
      }
    },
  }))

  assert.equal(requestedModel, 'openai-compatible')
  assert.equal(cleared, true)
  assert.match(output, /Model set to: openai-compatible \(openai: deepseek-chat\)/)
})

test('/model reports available models when switch target is unknown', async () => {
  let output = ''
  let cleared = false
  await modelCommand.run('missing', createContext({
    writeLine: (message) => {
      output = message
    },
    clearCachedSections: () => {
      cleared = true
    },
    setModel: () => ({
      ok: false,
      message: 'Unknown model: missing',
      availableModels: ['claude', 'openai-compatible'],
    }),
  }))

  assert.match(output, /Unknown model: missing/)
  assert.match(output, /Available models: claude, openai-compatible/)
  assert.equal(cleared, false)
})

test('/clear clears messages before writing confirmation', async () => {
  const events: string[] = []
  await clearCommand.run('', createContext({
    clearMessages: async () => {
      events.push('clear')
    },
    clearCachedSections: () => {
      events.push('clear-cache')
    },
    writeLine: (message) => {
      events.push(message)
    },
  }))

  assert.deepEqual(events, [
    'clear',
    'clear-cache',
    'Conversation cleared. Started a new session.',
  ])
})

test('/compact reset clears persistent failure circuit', async () => {
  const events: string[] = []
  await compactCommand.run('reset', createContext({
    resetCompactFailureCount: async () => {
      events.push('reset')
    },
    clearCachedSections: () => {
      events.push('clear-cache')
    },
    writeLine: (message) => {
      events.push(message)
    },
  }))

  assert.deepEqual(events, [
    'reset',
    'clear-cache',
    'Auto-compact failure circuit reset.',
  ])
})
