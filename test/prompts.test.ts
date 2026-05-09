import test from 'node:test'
import assert from 'node:assert/strict'
import { ContextBudget, countMessageTokens, countMessagesTokens } from '../src/prompts/budget.js'
import { PromptComposer } from '../src/prompts/composer.js'
import type { ChatMessage } from '../src/harness/types.js'

test('ContextBudget counts tokens', () => {
  const budget = new ContextBudget(1000)

  const msg: ChatMessage = {
    id: '1',
    role: 'user',
    content: 'Hello world',
    createdAt: new Date().toISOString(),
  }
  const tokens = countMessageTokens(msg)
  assert.ok(tokens > 0)

  const multiTokens = countMessagesTokens([msg, msg])
  assert.equal(multiTokens.messages.length, 2)
  assert.ok(multiTokens.total > tokens)
})

test('ContextBudget truncates messages within budget', () => {
  const budget = new ContextBudget(100)

  const messages: ChatMessage[] = [
    { id: '1', role: 'user', content: 'Short', createdAt: new Date().toISOString() },
    { id: '2', role: 'user', content: 'A'.repeat(500), createdAt: new Date().toISOString() },
    { id: '3', role: 'user', content: 'Should be truncated', createdAt: new Date().toISOString() },
  ]

  const truncated = budget.truncate(messages)
  assert.ok(truncated.length < messages.length)
})

test('PromptComposer builds request messages', () => {
  const composer = new PromptComposer()
  const budget = new ContextBudget(2000)

  const messages: ChatMessage[] = [
    { id: '1', role: 'user', content: 'Hello', createdAt: new Date().toISOString() },
  ]

  const result = composer.compose(messages, { budget, includeHistory: true })
  assert.equal(result.messages.length, 1)
  assert.equal(result.messages[0].content, 'Hello')

  const noHistory = composer.compose(messages, { budget, includeHistory: false })
  assert.equal(noHistory.messages.length, 0)
})
