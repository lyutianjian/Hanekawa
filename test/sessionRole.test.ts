import test from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod/v3'
import { initialPermissionMode, sessionRoleOf, sessionSwitchBlocked, toolAvailableForRole } from '../src/runtime/sessionRole.js'

const tool = (name: string, sessionRoles?: readonly ('coordinator' | 'thread')[]) =>
  ({
    name,
    description: name,
    inputSchema: z.object({}).strict(),
    riskLevel: 'safe',
    isReadOnly: true,
    isConcurrencySafe: true,
    sessionRoles,
    execute: async () => ({ ok: true, content: '' }),
  }) as never

test('sessionRoleOf reads the coordination role', () => {
  assert.equal(sessionRoleOf(undefined), undefined)
  assert.equal(sessionRoleOf({}), undefined)
  assert.equal(sessionRoleOf({ coordination: { role: 'thread' } }), 'thread')
})

test('initialPermissionMode by role', () => {
  assert.equal(initialPermissionMode('coordinator', 'bypass'), 'readonly')
  assert.equal(initialPermissionMode('thread', 'default'), 'auto')
  assert.equal(initialPermissionMode(undefined, 'plan'), 'plan')
})

test('toolAvailableForRole', () => {
  assert.equal(toolAvailableForRole(tool('Read'), undefined), true)
  assert.equal(toolAvailableForRole(tool('Spawn', ['coordinator']), undefined), false)
  assert.equal(toolAvailableForRole(tool('Spawn', ['coordinator']), 'thread'), false)
  assert.equal(toolAvailableForRole(tool('Spawn', ['coordinator']), 'coordinator'), true)
  assert.equal(toolAvailableForRole(tool('EnterPlanMode'), 'coordinator'), false)
  assert.equal(toolAvailableForRole(tool('ExitPlanMode'), 'coordinator'), false)
  assert.equal(toolAvailableForRole(tool('EnterPlanMode'), 'thread'), true)
})

test('sessionSwitchBlocked for coordination roles only', () => {
  assert.equal(sessionSwitchBlocked('thread'), true)
  assert.equal(sessionSwitchBlocked('coordinator'), true)
  assert.equal(sessionSwitchBlocked(undefined), false)
})
