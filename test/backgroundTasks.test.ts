import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import test from 'node:test'
import assert from 'node:assert/strict'
import { BackgroundTaskRegistry, MAX_BACKGROUND_OUTPUT_BYTES } from '../src/services/backgroundTasks/registry.js'
import { createBashTool } from '../src/tools/BashTool/BashTool.js'
import { createBashOutputTool } from '../src/tools/BashOutputTool/BashOutputTool.js'
import { createKillShellTool } from '../src/tools/KillShellTool/KillShellTool.js'
import type { SessionRecord } from '../src/harness/types.js'

function context() {
  return { cwd: process.cwd(), sessionId: 'session-1', readFiles: new Set<string>() }
}

test('background Bash returns immediately and BashOutput consumes incremental output', async () => {
  const registry = new BackgroundTaskRegistry()
  const bash = createBashTool(registry)
  const output = createBashOutputTool(registry)
  try {
    await bash.execute({ command: 'echo warmup' }, context())
    const startedAt = Date.now()
    // Windows shell detection prefers Git Bash, where PowerShell's `& ` call
    // operator is a syntax error; bare `node` from PATH works in both shells.
    const executable = process.platform === 'win32' ? 'node' : JSON.stringify(process.execPath)
    const command = `${executable} -e "console.log('first'); setTimeout(() => console.log('second'), 400)"`
    const result = await bash.execute({
      command,
      run_in_background: true,
    }, context())
    assert.equal(result.ok, true)
    assert.ok(Date.now() - startedAt < 350)
    const taskId = result.content.match(/Task ID: (bash_\d+)/)?.[1]
    assert.ok(taskId)

    const first = await output.execute({ task_id: taskId, wait_ms: 3_000 }, context())
    assert.equal(first.ok, true)
    assert.match(first.content, /first/)

    // Output can arrive before the shell's exit event, especially under the
    // full suite's process load on Windows. Wait for the state being asserted.
    await waitFor(() => registry.getTask('session-1', taskId)?.status === 'completed')
    const second = await output.execute({ task_id: taskId, wait_ms: 1_000 }, context())
    assert.equal(second.ok, true)
    assert.match(second.content, /second/)
    assert.doesNotMatch(second.content, /first/)
    assert.equal(registry.getTask('session-1', taskId)?.status, 'completed')
  } finally {
    await registry.stopAll()
  }
})

test('KillShell terminates a running task and is idempotent for terminal tasks', async () => {
  const registry = new BackgroundTaskRegistry()
  const bash = createBashTool(registry)
  const kill = createKillShellTool(registry)
  try {
    // node one-liner keeps the task alive in both Git Bash and PowerShell.
    const command = `${process.platform === 'win32' ? 'node' : JSON.stringify(process.execPath)} -e "setTimeout(() => {}, 30000)"`
    const result = await bash.execute({ command, run_in_background: true }, context())
    const taskId = result.content.match(/Task ID: (bash_\d+)/)?.[1]
    assert.ok(taskId)
    const killed = await kill.execute({ task_id: taskId }, context())
    assert.equal(killed.ok, true)
    assert.equal(registry.getTask('session-1', taskId)?.status, 'killed')
    const again = await kill.execute({ task_id: taskId }, context())
    assert.equal(again.ok, true)
    assert.match(again.content, /already killed/)
  } finally {
    await registry.stopAll()
  }
})

test('an explicit background timeout terminates the task as failed', async () => {
  const registry = new BackgroundTaskRegistry()
  const bash = createBashTool(registry)
  try {
    const command = process.platform === 'win32' ? 'node -e "setTimeout(() => {}, 30000)"' : 'sleep 30'
    const result = await bash.execute({ command, run_in_background: true, timeout: 100 }, context())
    const taskId = result.content.match(/Task ID: (bash_\d+)/)?.[1]
    assert.ok(taskId)
    await waitFor(() => registry.getTask('session-1', taskId)?.status === 'failed')
    assert.match(registry.getTask('session-1', taskId)?.reason ?? '', /timed out/)
  } finally {
    await registry.stopAll()
  }
})

test('ring buffer reports overwritten bytes and retains only the newest 1MB', async () => {
  const registry = new BackgroundTaskRegistry()
  const proc = Object.assign(new EventEmitter(), {
    pid: undefined,
    exitCode: null,
    signalCode: null,
    kill: () => true,
  }) as unknown as ChildProcess
  const task = registry.registerShell({ sessionId: 'session-1', command: 'fake', proc })
  registry.appendOutput('session-1', task.id, Buffer.alloc(MAX_BACKGROUND_OUTPUT_BYTES + 128, 97))
  const read = await registry.readOutput({ sessionId: 'session-1', taskId: task.id })
  assert.ok(read)
  assert.equal(read.droppedBytes, 128)
  assert.equal(read.output.length, 90_000)
  assert.equal(read.moreAvailable, true)
})

test('restore marks running persisted tasks orphaned and preserves terminal tasks', async () => {
  const persisted: SessionRecord[] = []
  const registry = new BackgroundTaskRegistry(async (_sessionId, record) => { persisted.push(record) })
  const records: SessionRecord[] = [
    backgroundRecord('bash_3', 'shell', 'running'),
    backgroundRecord('agent_2', 'agent', 'completed'),
  ]
  await registry.restoreSession('session-1', records)
  assert.equal(registry.getTask('session-1', 'bash_3')?.status, 'orphaned')
  assert.equal(registry.getTask('session-1', 'agent_2')?.status, 'completed')
  assert.ok(persisted.some((record) => record.type === 'background_task' && record.taskId === 'bash_3' && record.status === 'orphaned'))
})

test('BashOutput validates filters and rejects agent task ids', async () => {
  const registry = new BackgroundTaskRegistry()
  const output = createBashOutputTool(registry)
  const proc = Object.assign(new EventEmitter(), {
    pid: undefined,
    exitCode: null,
    signalCode: null,
    kill: () => true,
  }) as unknown as ChildProcess
  registry.registerShell({ sessionId: 'session-1', command: 'fake', proc })
  registry.registerAgent({ sessionId: 'session-1', agentId: 'uuid', agentType: 'general', description: 'agent' })
  const invalid = await output.execute({ task_id: 'bash_1', filter: '[' }, context())
  assert.equal(invalid.errorCode, 'invalid_input')
  const agent = await output.execute({ task_id: 'agent_1' }, context())
  assert.equal(agent.errorCode, 'precondition_failed')
})

test('agent tasks share registry status and subscriptions with shell tasks', () => {
  const registry = new BackgroundTaskRegistry()
  let notifications = 0
  const unsubscribe = registry.subscribe(() => { notifications++ })
  const task = registry.registerAgent({
    sessionId: 'session-1',
    agentId: 'agent-uuid',
    agentType: 'general',
    description: 'research',
  })
  registry.completeAgent('session-1', 'agent-uuid', 'completed')
  unsubscribe()
  assert.equal(task.id, 'agent_1')
  assert.equal(registry.getTask('session-1', task.id)?.status, 'completed')
  assert.ok(notifications >= 2)
})

test('restored short agent ids seed the next per-type id', async () => {
  const registry = new BackgroundTaskRegistry()
  const record = backgroundRecord('agent_2', 'agent', 'completed')
  record.agentId = 'explore-4'
  await registry.restoreSession('session-1', [record])
  assert.equal(registry.allocateAgentId('session-1', 'explore'), 'explore-5')
})

function backgroundRecord(
  taskId: string,
  kind: 'shell' | 'agent',
  status: 'running' | 'completed',
): Extract<SessionRecord, { type: 'background_task' }> {
  return {
    id: `${taskId}-record`,
    type: 'background_task',
    taskId,
    sessionId: 'session-1',
    kind,
    status,
    ...(kind === 'agent' ? { agentId: 'agent-uuid', agentType: 'general' } : { command: 'sleep 1' }),
    startedAt: 1,
    createdAt: new Date().toISOString(),
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for background task state')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}
