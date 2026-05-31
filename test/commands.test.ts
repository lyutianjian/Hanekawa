import test from 'node:test'
import assert from 'node:assert/strict'
import { clearCommand } from '../src/commands/clear.js'
import { compactCommand } from '../src/commands/compact.js'
import { costCommand } from '../src/commands/cost.js'
import { modelCommand } from '../src/commands/model.js'
import { repairCommand } from '../src/commands/repair.js'
import { verifyCommand } from '../src/commands/verify.js'
import { agentsCommand } from '../src/commands/agents.js'
import { planCommand } from '../src/commands/plan.js'
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

test('/cost reports cache summary when available', async () => {
  let output = ''
  await costCommand.run('', createContext({
    writeLine: (message) => {
      output = message
    },
    getUsage: () => ({
      cacheReadInputTokens: 100,
      inputTokens: 100,
      outputTokens: 50,
    }),
    getSessionMetricsSummary: async () => ({
      totalCacheHitRate: 0.625,
      totalTurns: 8,
      firstBreakTurnCount: 3,
      cacheBreakCount: 2,
      averageCompactIntervalTurns: 4.5,
    }),
  }))

  assert.match(output, /Session cache:/)
  assert.match(output, /Cache hit rate:\s+62\.5%/)
  assert.match(output, /First break turn:\s+3/)
  assert.match(output, /Avg compact interval:\s+4\.5 turns/)
})

test('/cost reports unavailable cache summary fields as n\\/a', async () => {
  let output = ''
  await costCommand.run('', createContext({
    writeLine: (message) => {
      output = message
    },
    getUsage: () => ({
      cacheReadInputTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
    }),
    getSessionMetricsSummary: async () => ({
      totalCacheHitRate: null,
      totalTurns: 0,
      firstBreakTurnCount: null,
      cacheBreakCount: 0,
      averageCompactIntervalTurns: null,
    }),
  }))

  assert.match(output, /Cache hit rate:\s+n\/a/)
  assert.match(output, /First break turn:\s+n\/a/)
  assert.match(output, /Avg compact interval:\s+n\/a/)
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

test('/plan enters plan mode without opening a missing plan file', async () => {
  const events: string[] = []
  let entered = false
  let opened = false
  await planCommand.run('open', createContext({
    getPermissionMode: () => 'default',
    enterPlanMode: () => { entered = true },
    openPlanFile: async () => {
      opened = true
      return { message: 'opened' }
    },
    writeLine: (message) => { events.push(message) },
  }))

  assert.equal(entered, true)
  assert.equal(opened, false)
  assert.deepEqual(events, ['Enabled plan mode.'])
})

test('/plan with description enters plan mode and submits the description', async () => {
  const submitted: string[] = []
  const events: string[] = []
  await planCommand.run('Design Plan Please', createContext({
    getPermissionMode: () => 'default',
    enterPlanMode: () => {},
    submitQuery: async (input) => { submitted.push(input) },
    writeLine: (message) => { events.push(message) },
  }))

  assert.deepEqual(events, ['Enabled plan mode.'])
  assert.deepEqual(submitted, ['Design Plan Please'])
})

test('/plan in plan mode reports empty draft path', async () => {
  let output = ''
  await planCommand.run('', createContext({
    getPermissionMode: () => 'plan',
    readPlanFile: async () => ({ path: '/tmp/project/.myagent/plans/test.md', content: null }),
    writeLine: (message) => { output = message },
  }))

  assert.match(output, /No draft plan written yet/)
  assert.match(output, /test\.md/)
})

test('/plan open in plan mode opens only after content exists', async () => {
  const events: string[] = []
  let opened = false
  await planCommand.run('open', createContext({
    getPermissionMode: () => 'plan',
    readPlanFile: async () => ({ path: '/tmp/project/.myagent/plans/test.md', content: '# Plan\n' }),
    openPlanFile: async () => {
      opened = true
      return { message: 'Opened plan in editor: /tmp/project/.myagent/plans/test.md' }
    },
    writeLine: (message) => { events.push(message) },
  }))

  assert.equal(opened, true)
  assert.deepEqual(events, ['Opened plan in editor: /tmp/project/.myagent/plans/test.md'])
})

test('/repair runs session repair and invalidates caches', async () => {
  const events: string[] = []
  await repairCommand.run('', createContext({
    repairRecords: async () => ({
      repairedCount: 1,
      diagnostics: [{ message: 'Inserted synthetic tool_result for orphan tool_use record: call-1' }],
    }),
    invalidateRecordsCache: () => {
      events.push('invalidate-records')
    },
    clearCachedSections: () => {
      events.push('clear-cache')
    },
    writeLine: (message) => {
      events.push(message)
    },
  }))

  assert.equal(events[0], 'invalidate-records')
  assert.equal(events[1], 'clear-cache')
  assert.match(events[2] ?? '', /Session invariants repaired/)
  assert.match(events[2] ?? '', /Inserted synthetic tool_result/)
})

test('/verify reports unavailable runtime without verification hook', async () => {
  let output = ''
  await verifyCommand.run('', createContext({
    writeLine: (message) => {
      output = message
    },
  }))

  assert.match(output, /unavailable/)
})

test('/verify delegates focus text to verification runner', async () => {
  const events: string[] = []
  await verifyCommand.run('check edge cases', createContext({
    writeLine: (message) => {
      events.push(message)
    },
    runVerification: async (args) => `verified: ${args}`,
  }))

  assert.deepEqual(events, [
    'Starting adversarial verification...',
    'verified: check edge cases',
  ])
})

test('/agents reload delegates to agent definition reloader', async () => {
  const events: string[] = []
  await agentsCommand.run('reload', createContext({
    writeLine: (message) => {
      events.push(message)
    },
    reloadAgentDefinitions: async () => 2,
  }))

  assert.deepEqual(events, ['Reloaded 2 custom agent definitions.'])
})

test('/agents reports usage for unknown subcommands', async () => {
  let output = ''
  await agentsCommand.run('', createContext({
    writeLine: (message) => {
      output = message
    },
  }))

  assert.match(output, /Usage: \/agents reload/)
})
