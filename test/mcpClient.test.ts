import test from 'node:test'
import assert from 'node:assert/strict'
import { connectMcpServer, isMcpSessionExpiredError } from '../src/services/mcp/client.js'

test('isMcpSessionExpiredError detects closed and expired MCP sessions', () => {
  assert.equal(isMcpSessionExpiredError(Object.assign(new Error('Connection closed'), { code: -32000 })), true)
  assert.equal(isMcpSessionExpiredError(Object.assign(new Error('Session not found'), { code: -32001 })), true)
  assert.equal(isMcpSessionExpiredError(new Error('Bad Request: Mcp-Session-Id header is required')), true)
  // Generic 'Unauthorized' is NOT a session expiry — it's a credentials issue
  // that reconnecting won't fix.
  assert.equal(isMcpSessionExpiredError(Object.assign(new Error('Unauthorized'), { name: 'UnauthorizedError' })), false)
})

test('a remote server config is rejected before any connection is attempted', async () => {
  await assert.rejects(
    connectMcpServer({ transport: 'sse' }),
    /sse transport requires "url"/,
  )
  await assert.rejects(
    // Parses as a URL — scheme `localhost:` — but would fail deep inside `fetch`.
    connectMcpServer({ transport: 'sse', url: 'localhost:3000' }),
    /must be http or https/,
  )
})

test('isMcpSessionExpiredError ignores unrelated request failures', () => {
  assert.equal(isMcpSessionExpiredError(Object.assign(new Error('Method not found'), { code: -32601 })), false)
  assert.equal(isMcpSessionExpiredError(new Error('Tool failed')), false)
  assert.equal(isMcpSessionExpiredError(null), false)
})
