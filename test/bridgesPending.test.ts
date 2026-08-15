import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createAskUserQuestionProxy,
  createEnterPlanProxy,
  createExitPlanProxy,
  createPromptProxy,
  createUiBridges,
} from '../src/runtime/bridges.js'
import type { PermissionRequest } from '../src/harness/permissions.js'
import type { Tool } from '../src/harness/types.js'

/**
 * The permission bridge is the one request proxy that parks instead of
 * answering while no UI is attached. Silently denying was invisible in a
 * terminal — the window between bootstrap and mount is milliseconds — but a
 * desktop renderer can take seconds to come up and would auto-deny real tool
 * calls. The other three bridges keep answering immediately, because headless
 * callers depend on it; they are covered here only to pin that asymmetry.
 */

const fakeTool = { name: 'Bash', riskLevel: 'confirm' } as unknown as Tool

function permissionRequest(overrides: Partial<PermissionRequest> = {}): PermissionRequest {
  return {
    tool: fakeTool,
    input: { command: 'ls' },
    reason: 'test',
    source: 'mode',
    denialStreak: 0,
    ...overrides,
  } as PermissionRequest
}

test('createPromptProxy: a request arriving before any UI parks until one attaches', async () => {
  const proxy = createPromptProxy()
  let settled: boolean | undefined
  const pending = proxy.prompt(permissionRequest()).then((value) => { settled = value })

  await Promise.resolve()
  assert.equal(settled, undefined, 'must not answer while no UI is attached')

  proxy.setPrompt(async () => true)
  await pending
  assert.equal(settled, true, 'the attaching UI answers the parked request')
})

test('createPromptProxy: parked requests are handed to the UI in arrival order', async () => {
  const proxy = createPromptProxy()
  const seen: string[] = []

  const first = proxy.prompt(permissionRequest({ reason: 'first' }))
  const second = proxy.prompt(permissionRequest({ reason: 'second' }))

  proxy.setPrompt(async (request) => {
    seen.push(request.reason)
    return true
  })

  assert.deepEqual(await Promise.all([first, second]), [true, true])
  assert.deepEqual(seen, ['first', 'second'])
})

test('createPromptProxy: drainPending denies whatever is still parked', async () => {
  const proxy = createPromptProxy()
  const pending = proxy.prompt(permissionRequest())

  proxy.drainPending()

  assert.equal(await pending, false, 'a UI that never attaches must not hang ToolRunner')
})

test('createPromptProxy: drainPending is a no-op once a UI has attached', async () => {
  const proxy = createPromptProxy()
  let asked = 0
  proxy.setPrompt(async () => { asked += 1; return true })

  const pending = proxy.prompt(permissionRequest())
  proxy.drainPending()

  assert.equal(await pending, true, 'the attached UI still owns its in-flight request')
  assert.equal(asked, 1)
})

test('createPromptProxy: clearPrompt parks later requests instead of denying them', async () => {
  const proxy = createPromptProxy()
  proxy.setPrompt(async () => true)
  assert.equal(await proxy.prompt(permissionRequest()), true)

  proxy.clearPrompt()

  let settled: boolean | undefined
  const pending = proxy.prompt(permissionRequest()).then((value) => { settled = value })
  await Promise.resolve()
  assert.equal(settled, undefined, 'detached is "no UI yet", not "deny"')

  proxy.setPrompt(async () => false)
  await pending
  assert.equal(settled, false, 'the next UI to attach answers it')
})

test('the four request bridges keep their asymmetric pre-mount answers', async () => {
  // todo.md calls these out explicitly: they are deliberately different and
  // must not be unified. Only the permission bridge parks.
  const bridges = createUiBridges()

  let permissionSettled = false
  void bridges.prompt.prompt(permissionRequest()).then(() => { permissionSettled = true })
  await Promise.resolve()
  assert.equal(permissionSettled, false, 'permission parks')

  assert.equal(await createEnterPlanProxy().open(), true, 'entering plan mode auto-approves')

  const exit = await createExitPlanProxy().open({ planContent: 'p', planFilePath: 'p.md' })
  assert.equal(exit.kind, 'reject', 'exiting plan mode auto-rejects')

  const answer = await createAskUserQuestionProxy().ask({ questions: [] })
  assert.equal(answer.kind, 'rejected', 'AskUserQuestion auto-rejects')
})
