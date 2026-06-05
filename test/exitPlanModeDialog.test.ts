import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildExitPlanModeOptions,
  elevatedExitPlanModeDecision,
  previewMarkdownLines,
} from '../src/tui/components/ExitPlanModeDialog.js'

test('ExitPlanModeDialog options prefer auto mode when available', () => {
  const options = buildExitPlanModeOptions({ isAutoModeAvailable: true, isBypassAvailable: false })

  assert.deepEqual(
    options.map((option) => option.label),
    [
      'Yes, clear context and use auto mode',
      'Yes, and use auto mode',
      'Yes, manually approve edits',
      'No, keep planning',
    ],
  )
  assert.deepEqual(
    options.map((option) => option.kind),
    [
      'approve_clear_auto_with_plan_as_prompt',
      'approve_auto_keep',
      'approve_restore_keep',
      'reject',
    ],
  )
})

test('ExitPlanModeDialog options replace elevated slots with bypass when available', () => {
  const options = buildExitPlanModeOptions({ isAutoModeAvailable: false, isBypassAvailable: true })

  assert.deepEqual(
    options.map((option) => option.label),
    [
      'Yes, clear context and bypass permissions',
      'Yes, and bypass permissions',
      'Yes, manually approve edits',
      'No, keep planning',
    ],
  )
  assert.deepEqual(
    options.map((option) => option.kind),
    [
      'approve_clear_bypass_with_plan_as_prompt',
      'approve_bypass_keep',
      'approve_restore_keep',
      'reject',
    ],
  )
})

test('ExitPlanModeDialog Shift+Tab resolves to the keep-context elevated option', () => {
  assert.equal(elevatedExitPlanModeDecision({ isAutoModeAvailable: true, isBypassAvailable: false }), 'approve_auto_keep')
  assert.equal(elevatedExitPlanModeDecision({ isAutoModeAvailable: false, isBypassAvailable: false }), 'approve_acceptEdits_keep')
  assert.equal(elevatedExitPlanModeDecision({ isAutoModeAvailable: false, isBypassAvailable: true }), 'approve_bypass_keep')
})

test('ExitPlanModeDialog previewMarkdownLines truncates long content while preserving head and tail', () => {
  const content = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join('\n')
  const preview = previewMarkdownLines(content, 5)

  assert.match(preview, /^line 1\nline 2\nline 3/)
  assert.match(preview, /\[\.\.\. 8 lines omitted from preview \.\.\.\]/)
  assert.match(preview, /line 12$/)
  assert.equal(preview.split('\n').length, 5)
})

test('ExitPlanModeDialog preview leaves short plans untouched', () => {
  const content = 'line 1\nline 2'
  assert.equal(previewMarkdownLines(content, 5), content)
})
