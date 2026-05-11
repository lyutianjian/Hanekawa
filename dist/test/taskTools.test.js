import test from 'node:test';
import assert from 'node:assert/strict';
import { taskCreateTool, taskUpdateTool, taskListTool, taskGetTool } from '../src/tools/taskTools.js';
function makeContext() {
    return {
        cwd: process.cwd(),
        sessionId: 'test-session',
        readFiles: new Set(),
        taskState: new Map(),
    };
}
test('TaskCreate creates a pending task', async () => {
    const ctx = makeContext();
    const result = await taskCreateTool.execute({ subject: 'Fix auth bug', description: 'Fix the login flow' }, ctx);
    assert.equal(result.ok, true);
    assert.match(result.content, /Task created:/);
    const tasks = ctx.taskState;
    assert.equal(tasks.size, 1);
    const task = [...tasks.values()][0];
    assert.equal(task.subject, 'Fix auth bug');
    assert.equal(task.status, 'pending');
    assert.deepEqual(task.blockedBy, []);
});
test('TaskUpdate changes task status and fields', async () => {
    const ctx = makeContext();
    await taskCreateTool.execute({ subject: 'Test', description: 'Run tests' }, ctx);
    const taskId = [...ctx.taskState.keys()][0];
    const result = await taskUpdateTool.execute({
        taskId,
        status: 'in_progress',
        subject: 'Updated test',
    }, ctx);
    assert.equal(result.ok, true);
    const task = ctx.taskState.get(taskId);
    assert.equal(task.status, 'in_progress');
    assert.equal(task.subject, 'Updated test');
});
test('TaskUpdate adds blockedBy and blocks', async () => {
    const ctx = makeContext();
    await taskCreateTool.execute({ subject: 'Task A', description: 'First task' }, ctx);
    await taskCreateTool.execute({ subject: 'Task B', description: 'Second task' }, ctx);
    const [idA, idB] = [...ctx.taskState.keys()];
    await taskUpdateTool.execute({ taskId: idA, addBlocks: [idB] }, ctx);
    await taskUpdateTool.execute({ taskId: idB, addBlockedBy: [idA] }, ctx);
    assert.deepEqual(ctx.taskState.get(idA).blocks, [idB]);
    assert.deepEqual(ctx.taskState.get(idB).blockedBy, [idA]);
});
test('TaskList shows only non-deleted tasks', async () => {
    const ctx = makeContext();
    await taskCreateTool.execute({ subject: 'Keep', description: 'Visible' }, ctx);
    await taskCreateTool.execute({ subject: 'Drop', description: 'Deleted' }, ctx);
    const [, idDrop] = [...ctx.taskState.keys()];
    await taskUpdateTool.execute({ taskId: idDrop, status: 'deleted' }, ctx);
    const result = await taskListTool.execute({}, ctx);
    assert.equal(result.ok, true);
    assert.match(result.content, /Keep/);
    assert.doesNotMatch(result.content, /Drop/);
});
test('TaskList filters by status', async () => {
    const ctx = makeContext();
    await taskCreateTool.execute({ subject: 'Pending task', description: '...' }, ctx);
    await taskCreateTool.execute({ subject: 'Done task', description: '...' }, ctx);
    const [, idDone] = [...ctx.taskState.keys()];
    await taskUpdateTool.execute({ taskId: idDone, status: 'completed' }, ctx);
    const result = await taskListTool.execute({ status: 'completed' }, ctx);
    assert.equal(result.ok, true);
    assert.doesNotMatch(result.content, /Pending task/);
    assert.match(result.content, /Done task/);
});
test('TaskGet returns full task details', async () => {
    const ctx = makeContext();
    await taskCreateTool.execute({
        subject: 'Complex task',
        description: 'A detailed description',
        activeForm: 'Working on it',
    }, ctx);
    const taskId = [...ctx.taskState.keys()][0];
    const result = await taskGetTool.execute({ taskId }, ctx);
    assert.equal(result.ok, true);
    assert.match(result.content, /Complex task/);
    assert.match(result.content, /A detailed description/);
    assert.match(result.content, /Working on it/);
    assert.match(result.content, /pending/);
});
test('TaskGet returns error for unknown task', async () => {
    const ctx = makeContext();
    const result = await taskGetTool.execute({ taskId: 'nonexistent' }, ctx);
    assert.equal(result.ok, false);
    assert.match(result.content, /not found/);
});
test('TaskUpdate rejects unknown task', async () => {
    const ctx = makeContext();
    const result = await taskUpdateTool.execute({ taskId: 'nope', status: 'completed' }, ctx);
    assert.equal(result.ok, false);
    assert.match(result.content, /not found/);
});
