import test from 'node:test'
import assert from 'node:assert/strict'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { wrapMcpTool } from '../src/services/mcp/toolWrapper.js'

test('wrapMcpTool marks schema mcp_readonly_hint tools as read-only', () => {
  const tool = wrapMcpTool('server', {
    name: 'search',
    description: 'Search docs',
    inputSchema: {
      type: 'object',
      properties: {},
      mcp_readonly_hint: true,
    },
  }, {} as Client)

  assert.equal(tool.isReadOnly, true)
  assert.equal(tool.isConcurrencySafe, true)
  assert.equal(tool.riskLevel, 'safe')
})

test('wrapMcpTool marks annotation readOnlyHint tools as read-only', () => {
  const tool = wrapMcpTool('server', {
    name: 'list',
    description: 'List docs',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    annotations: {
      readOnlyHint: true,
    },
  }, {} as Client)

  assert.equal(tool.isReadOnly, true)
  assert.equal(tool.riskLevel, 'safe')
})

test('wrapMcpTool leaves unannotated tools non-read-only', () => {
  const tool = wrapMcpTool('server', {
    name: 'write',
    description: 'Write docs',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  }, {} as Client)

  assert.equal(tool.isReadOnly, false)
  assert.equal(tool.isConcurrencySafe, false)
  assert.equal(tool.riskLevel, 'confirm')
})
