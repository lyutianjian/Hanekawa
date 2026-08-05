import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildFullPlanModeReminder,
  buildPlanFileReferenceReminder,
  buildPlanModeExitReminder,
  buildPlanModeReentryReminder,
  buildSparsePlanModeReminder,
  shouldInjectPlanAttachment,
  TURNS_BETWEEN_ATTACHMENTS,
  FULL_REMINDER_EVERY_N_ATTACHMENTS,
  type AttachmentDecisionState,
} from '../src/harness/planModeAttachments.js'

function emptyState(overrides: Partial<AttachmentDecisionState> = {}): AttachmentDecisionState {
  return {
    active: false,
    hasExitedThisSession: false,
    needsExitAttachment: false,
    toolUseTurnsSinceEntry: 0,
    attachmentInjections: 0,
    ...overrides,
  }
}

test('shouldInjectPlanAttachment returns full on entry (turn 0, first injection)', () => {
  const decision = shouldInjectPlanAttachment(emptyState({ active: true }))
  assert.equal(decision, 'full')
})

test('shouldInjectPlanAttachment returns reentry when session has previously exited', () => {
  const decision = shouldInjectPlanAttachment(emptyState({
    active: true,
    hasExitedThisSession: true,
  }))
  assert.equal(decision, 'reentry')
})

test('shouldInjectPlanAttachment returns undefined for non-active state', () => {
  const decision = shouldInjectPlanAttachment(emptyState())
  assert.equal(decision, undefined)
})

test('shouldInjectPlanAttachment returns undefined for turns 1..4 after first full', () => {
  for (let turn = 1; turn < TURNS_BETWEEN_ATTACHMENTS; turn += 1) {
    const decision = shouldInjectPlanAttachment(emptyState({
      active: true,
      toolUseTurnsSinceEntry: turn,
      attachmentInjections: 1,
    }))
    assert.equal(decision, undefined, `turn ${turn} should be silent`)
  }
})

test('shouldInjectPlanAttachment returns sparse on turn 5 after one prior injection', () => {
  const decision = shouldInjectPlanAttachment(emptyState({
    active: true,
    toolUseTurnsSinceEntry: 5,
    attachmentInjections: 1,
  }))
  assert.equal(decision, 'sparse')
})

test('shouldInjectPlanAttachment returns full at the FULL_REMINDER_EVERY_N_ATTACHMENTS rotation', () => {
  const decision = shouldInjectPlanAttachment(emptyState({
    active: true,
    toolUseTurnsSinceEntry: TURNS_BETWEEN_ATTACHMENTS * FULL_REMINDER_EVERY_N_ATTACHMENTS,
    attachmentInjections: FULL_REMINDER_EVERY_N_ATTACHMENTS,
  }))
  assert.equal(decision, 'full')
})

test('shouldInjectPlanAttachment returns exit when needsExitAttachment is set, regardless of active', () => {
  const decision = shouldInjectPlanAttachment(emptyState({
    needsExitAttachment: true,
  }))
  assert.equal(decision, 'exit')
})

test('30-turn simulation produces the expected attachment cadence', () => {
  const state = emptyState({ active: true })
  const sequence: Array<{ turn: number; kind: string | undefined }> = []
  for (let turn = 0; turn <= 30; turn += 1) {
    state.toolUseTurnsSinceEntry = turn
    const decision = shouldInjectPlanAttachment(state)
    sequence.push({ turn, kind: decision })
    if (decision && decision !== 'exit') {
      state.attachmentInjections += 1
    }
  }

  const expected: Record<number, string | undefined> = {
    0: 'full',
    5: 'sparse',
    10: 'sparse',
    15: 'sparse',
    20: 'sparse',
    25: 'full',
    30: 'sparse',
  }
  for (const [turnStr, expectedKind] of Object.entries(expected)) {
    const turn = Number(turnStr)
    const got = sequence[turn]?.kind
    assert.equal(got, expectedKind, `turn ${turn}: expected ${expectedKind}, got ${got}`)
  }
  for (const entry of sequence) {
    if (Object.prototype.hasOwnProperty.call(expected, entry.turn)) continue
    assert.equal(entry.kind, undefined, `turn ${entry.turn} should be silent, got ${entry.kind}`)
  }
})

test('reminders contain expected anchor text', () => {
  const planPath = '/abs/.myagent/plans/crimson-tiger-abc.md'
  const full = buildFullPlanModeReminder(planPath)
  // Aligned with Claude Code's getPlanModeV2Instructions wording.
  assert.match(full, /Plan mode is active/)
  assert.match(full, /supercedes any other instructions/)
  assert.match(full, /Phase 1: Initial Understanding/)
  assert.match(full, /Phase 4: Final Plan/)
  assert.match(full, /Phase 5: Call ExitPlanMode/)
  assert.match(full, /Use ExitPlanMode to request plan approval/)
  assert.match(full, new RegExp(planPath))
  // Allow/disallow tool sections
  assert.match(full, /AskUserQuestion ONLY to clarify/)
  assert.doesNotMatch(full, /Ordinary assistant-text plans are invalid/)
  assert.match(full, /Call ExitPlanMode/)
  assert.doesNotMatch(full, /Tools you must NOT call in plan mode/)

  const sparse = buildSparsePlanModeReminder(planPath)
  assert.match(sparse, /Plan mode still active/)
  assert.match(sparse, new RegExp(planPath))
  assert.match(sparse, /ExitPlanMode/)
  assert.match(sparse, /AskUserQuestion/)

  assert.match(buildPlanModeReentryReminder(planPath), /Re-entering Plan Mode/)
  assert.match(buildPlanModeReentryReminder(planPath), new RegExp(planPath))
  assert.match(buildPlanModeExitReminder('# Approved\n'), /Exited Plan Mode/)
  assert.match(buildPlanModeExitReminder('# Approved\n'), /# Approved/)
  assert.match(buildPlanFileReferenceReminder('test-slug', planPath), /Plan mode is active/)
  assert.match(buildPlanFileReferenceReminder('test-slug', planPath), /test-slug/)
  assert.match(buildPlanFileReferenceReminder('test-slug', planPath), new RegExp(planPath.replace(/\\/g, '\\\\')))
})

test('post-exit reminder nudges the model to update its task list', () => {
  // Mirrors Claude Code's ExitPlanModeV2Tool tool_result body:
  //   "User has approved your plan. You can now start coding. Start with
  //    updating your task list if applicable"
  // This is the moment in the workflow where TaskCreate/TaskUpdate is the natural next
  // action — paired with the in-plan-mode disallow, the boundary is clear.
  const reminder = buildPlanModeExitReminder('# Approved plan content\n')
  assert.match(reminder, /User has approved your plan/)
  assert.match(reminder, /Start with updating your task list/)
  assert.match(reminder, /TaskCreate\/TaskUpdate/)
  assert.match(reminder, /# Approved plan content/)
})

test('post-exit reminder still works when plan content is empty', () => {
  // The clear-context approval flow passes the plan as the new user prompt
  // and emits an exit reminder with no embedded plan body. The task nudge
  // must still appear so the model knows to start with TaskCreate/TaskUpdate.
  const reminder = buildPlanModeExitReminder('')
  assert.match(reminder, /User has approved exiting plan mode/)
  assert.match(reminder, /You can now proceed/)
  assert.doesNotMatch(reminder, /Approved plan content:/)
})
