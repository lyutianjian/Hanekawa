import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createElement as h } from 'react'
import { Text } from 'ink'
import { cleanup, render } from 'ink-testing-library'
import { usePermission } from '../src/tui/hooks/usePermission.js'
import { createPromptProxy } from '../src/runtime/bridges.js'
import type { PermissionRequest } from '../src/harness/permissions.js'
import type { RiskLevel, Tool } from '../src/harness/types.js'

/**
 * The hook is the in-process mirror of `SessionHost`'s prompt bridge: the
 * dialog gets a wire DTO, the live request stays here so `onAlwaysAllow` can
 * still fire. These render because the ordering guarantee only exists inside
 * `respond`, and it is invisible to a pure-function test.
 */

afterEach(() => cleanup())

type PermissionApi = ReturnType<typeof usePermission>

let captured: PermissionApi | undefined

function Harness({ proxy }: { proxy: ReturnType<typeof createPromptProxy> }) {
  captured = usePermission(proxy, { cwd: process.cwd() })
  return h(Text, null, String(captured.permState.requests.length))
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function tool(name: string, riskLevel: RiskLevel = 'confirm'): Tool {
  return {
    name,
    description: '',
    riskLevel,
    inputSchema: {} as Tool['inputSchema'],
    execute: async () => ({ ok: true, content: '' }),
  }
}

function permissionRequest(extra: Partial<PermissionRequest> = {}): PermissionRequest {
  return {
    tool: tool('Bash'),
    input: { command: 'npm test' },
    reason: 'requires confirmation',
    source: 'mode',
    denialStreak: 0,
    ...extra,
  }
}

test('the dialog receives a wire DTO rather than the live request', async () => {
  const proxy = createPromptProxy()
  render(h(Harness, { proxy }))

  const pending = proxy.prompt(permissionRequest())
  await tick()

  const entry = captured?.permState.requests[0]
  assert.ok(entry, 'the request should be on screen')
  assert.equal(entry.request.toolName, 'Bash')
  assert.equal(entry.request.riskLevel, 'confirm')
  assert.deepEqual(entry.request.destructiveWarnings, [])
  assert.ok(!('tool' in entry.request), 'the Tool must not reach the dialog')
  assert.ok(!('onAlwaysAllow' in entry.request), 'the callback must not reach the dialog')

  captured?.respond(entry.id, false)
  assert.equal(await pending, false)
})

test('always allow fires before the approval resolves', async () => {
  const proxy = createPromptProxy()
  render(h(Harness, { proxy }))

  const order: string[] = []
  const pending = proxy.prompt(permissionRequest({
    onAlwaysAllow: () => { order.push('always') },
  }))
  await tick()

  const entry = captured?.permState.requests[0]
  assert.ok(entry)
  captured?.respond(entry.id, true, true)

  const approved = await pending
  order.push('resolved')

  // PermissionGate reads the captured flag on the line after the prompt
  // resolves. Deferring this call past that continuation — into a useEffect or
  // any other macrotask — silently downgrades "always allow" to "allow once",
  // with no error and nothing else to notice it.
  assert.deepEqual(order, ['always', 'resolved'])
  assert.equal(approved, true)
})

test('a plain approval leaves the always-allow callback alone', async () => {
  const proxy = createPromptProxy()
  render(h(Harness, { proxy }))

  let fired = false
  const pending = proxy.prompt(permissionRequest({
    onAlwaysAllow: () => { fired = true },
  }))
  await tick()

  const entry = captured?.permState.requests[0]
  assert.ok(entry)
  captured?.respond(entry.id, true)

  assert.equal(await pending, true)
  assert.equal(fired, false)
})

test('a denial never fires always allow even when the flag is set', async () => {
  const proxy = createPromptProxy()
  render(h(Harness, { proxy }))

  let fired = false
  const pending = proxy.prompt(permissionRequest({
    onAlwaysAllow: () => { fired = true },
  }))
  await tick()

  const entry = captured?.permState.requests[0]
  assert.ok(entry)
  captured?.respond(entry.id, false, true)

  assert.equal(await pending, false)
  assert.equal(fired, false)
})

test('denyPending settles every request and drops the live ones', async () => {
  const proxy = createPromptProxy()
  render(h(Harness, { proxy }))

  let fired = false
  const first = proxy.prompt(permissionRequest({
    onAlwaysAllow: () => { fired = true },
  }))
  const second = proxy.prompt(permissionRequest({ tool: tool('Write') }))
  await tick()

  assert.equal(captured?.permState.requests.length, 2)
  const entry = captured?.permState.requests[0]
  assert.ok(entry)

  captured?.denyPending()

  assert.equal(await first, false)
  assert.equal(await second, false)
  await tick()
  assert.equal(captured?.permState.requests.length, 0)

  // The live request is gone, so a late respond cannot resurrect the callback.
  captured?.respond(entry.id, true, true)
  assert.equal(fired, false)
})

test('unmounting settles in-flight prompts instead of hanging the tool call', async () => {
  const proxy = createPromptProxy()
  const instance = render(h(Harness, { proxy }))

  const pending = proxy.prompt(permissionRequest())
  await tick()

  instance.unmount()

  // ToolRunner does not pass its abort signal into PermissionGate.approve, so
  // an abandoned resolver would hang the agent loop forever.
  assert.equal(await pending, false)
})
