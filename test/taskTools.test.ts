import test from 'node:test'
import assert from 'node:assert/strict'
import { taskCreateTool, taskGetTool, taskListTool, taskUpdateTool, todoWriteTool } from '../src/tools/taskTools.js'
import type { ToolContext } from '../src/harness/types.js'

function makeContext(): ToolContext {
  return {
    cwd: process.cwd(),
    sessionId: 'test-session',
    readFiles: new Set(),
    taskState: new Map(),
  }
}

test('TodoWrite replaces the session todo list', async () => {
  const ctx = makeContext()
  const result = await todoWriteTool.execute({
    todos: [
      { id: 'setup', content: 'Inspect tool definitions', status: 'completed' },
      { id: 'tests', content: 'Update tests', status: 'in_progress', activeForm: 'Updating tests' },
    ],
  }, ctx)

  assert.equal(result.ok, true)
  assert.match(result.content, /Inspect tool definitions/)
  assert.equal(ctx.taskState!.size, 2)
  assert.equal(ctx.taskState!.get('setup')!.status, 'completed')
  assert.equal(ctx.taskState!.get('tests')!.subject, 'Update tests')
  assert.equal(ctx.taskState!.get('tests')!.activeForm, 'Updating tests')
})

test('TodoWrite removes omitted todos on replacement', async () => {
  const ctx = makeContext()
  await todoWriteTool.execute({
    todos: [
      { id: 'one', content: 'Keep this', status: 'pending' },
      { id: 'two', content: 'Drop this', status: 'pending' },
    ],
  }, ctx)

  const result = await todoWriteTool.execute({
    todos: [
      { id: 'one', content: 'Keep this', status: 'completed' },
    ],
  }, ctx)

  assert.equal(result.ok, true)
  assert.equal(ctx.taskState!.size, 1)
  assert.equal(ctx.taskState!.has('two'), false)
  assert.equal(ctx.taskState!.get('one')!.status, 'completed')
})

test('TodoWrite assigns stable numeric ids when omitted', async () => {
  const ctx = makeContext()
  const result = await todoWriteTool.execute({
    todos: [
      { content: 'First', status: 'pending' },
      { content: 'Second', status: 'pending' },
    ],
  }, ctx)

  assert.equal(result.ok, true)
  assert.deepEqual([...ctx.taskState!.keys()], ['1', '2'])
})

test('TodoWrite rejects duplicate ids', async () => {
  const ctx = makeContext()
  const result = await todoWriteTool.execute({
    todos: [
      { id: 'dup', content: 'First', status: 'pending' },
      { id: 'dup', content: 'Second', status: 'pending' },
    ],
  }, ctx)

  assert.equal(result.ok, false)
  assert.equal(result.errorCode, 'invalid_input')
  assert.match(result.content, /Duplicate todo id/)
})

test('TaskCreate/List/Get/Update share task state and summarize remaining/completed tasks', async () => {
  const ctx = makeContext()

  const created = await taskCreateTool.execute({
    subject: 'Inspect plan mode',
    description: 'Compare behavior with Claude Code',
    activeForm: 'Inspecting plan mode',
  }, ctx)
  assert.equal(created.ok, true)
  assert.equal(ctx.taskState!.size, 1)

  const update = await taskUpdateTool.execute({
    taskId: '1',
    status: 'completed',
  }, ctx)
  assert.equal(update.ok, true)
  assert.match(update.metadata?.display?.summary ?? '', /0 remaining, 1 completed/)

  const get = await taskGetTool.execute({ taskId: '1' }, ctx)
  assert.equal(get.ok, true)
  assert.match(get.content, /Task #1: Inspect plan mode/)
  assert.match(get.content, /Status: completed/)

  const listed = await taskListTool.execute({}, ctx)
  assert.equal(listed.ok, true)
  assert.match(listed.content, /Completed tasks \(1\)/)
  assert.match(listed.metadata?.display?.detail ?? '', /#1 \[completed\]/)
})
